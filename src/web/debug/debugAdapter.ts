import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { processOptions } from '../runProgram';
import { getToolchainStore } from '../toolchain/toolchain';
import { describeUnsupportedImports } from '../toolchain/wasiImports';
import { DebugController, type DebugTarget } from './debugController';
import { LineEditor, toTerminalNewlines } from './lineEditor';
import { workspacePathMapper } from './pathMapper';
import { ReactorHost } from './reactorHost';
import { StubDebuggee } from './stubDebuggee';
import { scanProgram } from './wasmScan';

/** What a debug launch needs from the extension: the freshly built debug program, and the arguments to run it with. */
export interface DebugLaunchPlan { output: vscode.Uri; args: string[] }

/** Test seam: receives the program's terminal instead of opening a real one for it. */
export interface DebugHost {
	openTerminal?: (pty: ProgramTerminal) => void;
}

/** The debugged program's terminal: echoes and edits typed lines, hands each completed line to `onLine`, shows program output. */
export class ProgramTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly editor = new LineEditor();
	private pending: string[] | undefined = [];

	constructor(private readonly onLine: (line: string) => void) {}

	/** VS Code drops writes made before `open`, so they wait for it. */
	open(): void {
		const early = this.pending ?? [];
		this.pending = undefined;
		early.forEach(text => this.writeEmitter.fire(text));
	}

	close(): void { /* the session ends from the debug toolbar, not from closing the terminal */ }

	handleInput(data: string): void {
		const { echo, lines } = this.editor.feed(data);
		if (echo) { this.writeRaw(echo); }
		lines.forEach(this.onLine);
	}

	write(text: string): void { this.writeRaw(toTerminalNewlines(text)); }

	private writeRaw(text: string): void {
		if (this.pending) { this.pending.push(text); } else { this.writeEmitter.fire(text); }
	}
}

/**
 * Inline Debug Adapter: lives in the extension host (web extensions have no child processes).
 *
 * A thin shell over `DebugController`, which holds the protocol logic. This class does the parts that need VS Code:
 * `plan` builds the program in debug mode (returning undefined after reporting a failed build), then the program
 * runs under `wasm-wasi-core` with the debug stub's channel on its stdio, and lldb's reactor decodes its DWARF.
 *
 * By default (`console` is `integratedTerminal`) the program's stdin, stdout and stderr are a terminal: typed lines
 * reach the program while it runs and wait for the next resume while it is stopped (see `StubDebuggee`). There is no
 * end-of-file key. With `"console": "internalConsole"` its output goes to the Debug Console and its stdin is not
 * connected, so a program that reads input waits forever. A program that traps (out-of-bounds, `__builtin_trap`)
 * hangs the session until Stop, as in Run (vscode-wasm#303).
 */
export class VscwClangDebugAdapter implements vscode.DebugAdapter {
	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this.emitter.event;
	private readonly controller: DebugController;
	private target: DebugTarget | undefined;

	constructor(private readonly session: vscode.DebugSession, private readonly log: vscode.OutputChannel, private readonly context: vscode.ExtensionContext, private readonly plan: () => Promise<DebugLaunchPlan | undefined>, private readonly host: DebugHost = {}) {
		this.controller = new DebugController({
			launch: args => this.launchTarget(args.console !== 'internalConsole'),
			send: message => this.emitter.fire(message as vscode.DebugProtocolMessage),
		});
	}

	handleMessage(message: vscode.DebugProtocolMessage): void { this.controller.handleMessage(message); }

	private async launchTarget(useTerminal: boolean): Promise<DebugTarget> {
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
		const terminal = useTerminal ? this.openProgramTerminal(name, line => void debuggee?.writeInput(encoder.encode(line))) : undefined;
		void exited.then(code => terminal?.write(`\r\n[${name} exited with code ${code}]\r\n`), () => undefined);
		debuggee = new StubDebuggee({
			send: text => process.stdin!.write(encoder.encode(text)),
			sendInput: data => process.stdin!.write(data),
			onOutput: terminal && ((_stream, text) => terminal.write(text)),
			exited, terminate: () => void process.terminate(), guardSites: scan.guardSites,
		});

		const folder = this.session.workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!folder) { throw new Error('vscwClang: open a workspace folder before debugging.'); }
		this.target = { session: debuggee, reactor, program, scan, paths: workspacePathMapper({ uri: folder.toString(), scheme: folder.scheme, path: folder.path, fsPath: folder.fsPath }) };
		return this.target;
	}

	private openProgramTerminal(name: string, onLine: (line: string) => void): ProgramTerminal {
		const pty = new ProgramTerminal(onLine);
		if (this.host.openTerminal) { this.host.openTerminal(pty); } else { vscode.window.createTerminal({ name: `vscwClang debug: ${name}`, pty }).show(true); }
		return pty;
	}

	dispose(): void {
		void this.target?.session.terminate();
		this.emitter.dispose();
	}
}
