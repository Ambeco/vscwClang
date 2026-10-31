import * as vscode from 'vscode';
import { workerProgramEnvironment } from '../runProgram';
import { createWorkerProcess, type PipedProcess } from '../host/workerProcess';
import { getToolchainStore } from '../toolchain/toolchain';
import { DebugController, type DebugTarget } from './debugController';
import { ProgramTerminal } from '../host/programTerminal';
import { workspacePathMapper } from './pathMapper';
import { createGuestWorker } from '../host/workerHost';
import { WorkerThreads } from '../host/workerThreads';
import { sharedMemoryLimits } from '../host/sharedMemory';
import { ReactorHost } from './reactorHost';
import { StubDebuggee } from './stubDebuggee';
import { scanProgram } from './wasmScan';

/** What a debug launch needs from the extension: the freshly built debug program, and the arguments to run it with. */
export interface DebugLaunchPlan { output: vscode.Uri; args: string[] }

export { ProgramTerminal };

const terminalName = (program: string) => `vscwClang debug: ${program}`;

/** Test seam: receives the program's terminal instead of opening a real one for it. */
export interface DebugHost {
	openTerminal?: (pty: ProgramTerminal) => void;
}

/**
 * Inline Debug Adapter: lives in the extension host (web extensions have no child processes).
 *
 * A thin shell over `DebugController`, which holds the protocol logic. This class does the parts that need VS Code:
 * `plan` builds the program in debug mode (returning undefined after reporting a failed build), then the program
 * runs on the Worker host with the debug stub's channel on its stdio, and lldb's reactor decodes its DWARF.
 *
 * By default (`console` is `integratedTerminal`) the program's stdin, stdout and stderr are a terminal: typed lines
 * reach the program while it runs and wait for the next resume while it is stopped (see `StubDebuggee`). There is no
 * end-of-file key. With `"console": "internalConsole"` its output goes to the Debug Console and its stdin is not
 * connected, so a program that reads input waits forever. A program that traps (out-of-bounds, `__builtin_trap`) exits 139 with a message.
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
		const scan = scanProgram(program);
		const reactorBytes = await getToolchainStore(this.context, this.log).getFile('lldb-wasm-reactor.wasm');
		const spawner = await createGuestWorker(this.context);
		const reactor = await ReactorHost.create(reactorBytes, undefined, line => this.log.appendLine(line), new WorkerThreads(() => spawner, message => this.log.appendLine(`[vscwclang] lldb thread: ${message}`)));
		reactor.createTarget(program);

		const environment = await workerProgramEnvironment(this.context);
		const process = await createWorkerProcess(this.context, { name, module, args: plan.args, ...environment, memoryLimits: sharedMemoryLimits(program) });
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
		const notice = terminal ? `vscwClang: ${name}'s input and output are in the terminal "${terminalName(name)}". To see output here instead, set "console": "internalConsole" in launch.json (the program then gets no input).` : undefined;
		this.target = { session: debuggee, reactor, program, scan, paths: workspacePathMapper({ uri: folder.toString(), scheme: folder.scheme, path: folder.path, fsPath: folder.fsPath }), notice };
		return this.target;
	}

	private openProgramTerminal(name: string, onLine: (line: string) => void): ProgramTerminal {
		const pty = new ProgramTerminal(onLine);
		if (this.host.openTerminal) { this.host.openTerminal(pty); } else { vscode.window.createTerminal({ name: terminalName(name), pty }).show(true); }
		return pty;
	}

	dispose(): void {
		void this.target?.session.terminate();
		this.emitter.dispose();
	}
}
