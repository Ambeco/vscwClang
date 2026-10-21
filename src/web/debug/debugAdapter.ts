import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { processOptions } from '../runProgram';
import { getToolchainStore } from '../toolchain/toolchain';
import { describeUnsupportedImports } from '../toolchain/wasiImports';
import { DebugController, type DebugTarget } from './debugController';
import { workspacePathMapper } from './pathMapper';
import { ReactorHost } from './reactorHost';
import { StubDebuggee } from './stubDebuggee';
import { scanProgram } from './wasmScan';

/** What a debug launch needs from the extension: the freshly built debug program, and the arguments to run it with. */
export interface DebugLaunchPlan { output: vscode.Uri; args: string[] }

/**
 * Inline Debug Adapter: lives in the extension host (web extensions have no child processes).
 *
 * A thin shell over `DebugController`, which holds the protocol logic. This class does the parts that need VS Code:
 * `plan` builds the program in debug mode (returning undefined after reporting a failed build), then the program
 * runs under `wasm-wasi-core` with the debug stub's channel on its stdio, and lldb's reactor decodes its DWARF.
 *
 * The program's stdout and stderr go to the Debug Console; its stdin is not connected (the stub owns it), so a
 * program that reads input waits forever. A program that traps (out-of-bounds, `__builtin_trap`) hangs the session
 * until Stop, as in Run (vscode-wasm#303).
 */
export class VscwClangDebugAdapter implements vscode.DebugAdapter {
	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this.emitter.event;
	private readonly controller: DebugController;
	private target: DebugTarget | undefined;

	constructor(private readonly session: vscode.DebugSession, private readonly log: vscode.OutputChannel, private readonly context: vscode.ExtensionContext, private readonly plan: () => Promise<DebugLaunchPlan | undefined>) {
		this.controller = new DebugController({
			launch: () => this.launchTarget(),
			send: message => this.emitter.fire(message as vscode.DebugProtocolMessage),
		});
	}

	handleMessage(message: vscode.DebugProtocolMessage): void { this.controller.handleMessage(message); }

	private async launchTarget(): Promise<DebugTarget> {
		const plan = await this.plan();
		if (!plan) { throw new Error('vscwClang: the debug build failed or was cancelled; see Problems and the vscwclang output.'); }
		const name = plan.output.path.slice(plan.output.path.lastIndexOf('/') + 1);
		const program = await vscode.workspace.fs.readFile(plan.output) as Uint8Array<ArrayBuffer>;
		const module = await WebAssembly.compile(program);
		const unsupported = describeUnsupportedImports(WebAssembly.Module.imports(module));
		if (unsupported !== undefined) { throw new Error(`vscwClang: cannot debug ${name}. ${unsupported}`); }
		const scan = scanProgram(program);
		const reactorModule = await WebAssembly.compile(await getToolchainStore(this.context, this.log).getFile('lldb-wasm-reactor.wasm'));
		const reactor = await ReactorHost.create(reactorModule, undefined, line => this.log.appendLine(line));
		reactor.createTarget(program);

		const wasm = await Wasm.load();
		const process = await wasm.createProcess(name, module, { ...await processOptions(this.context, plan.args), stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } } });
		let debuggee: StubDebuggee | undefined;
		process.stdout?.onData(chunk => debuggee?.feedStdout(chunk));
		process.stderr?.onData(chunk => debuggee?.feedStderr(chunk));
		const exited = process.run();
		const encoder = new TextEncoder();
		debuggee = new StubDebuggee({ send: text => process.stdin!.write(encoder.encode(text)), exited, terminate: () => void process.terminate(), guardSites: scan.guardSites });

		const folder = this.session.workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!folder) { throw new Error('vscwClang: open a workspace folder before debugging.'); }
		this.target = { session: debuggee, reactor, program, scan, paths: workspacePathMapper({ uri: folder.toString(), scheme: folder.scheme, path: folder.path, fsPath: folder.fsPath }) };
		return this.target;
	}

	dispose(): void {
		void this.target?.session.terminate();
		this.emitter.dispose();
	}
}
