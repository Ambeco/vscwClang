import * as vscode from 'vscode';
import { type Environment, type MountPointDescriptor } from '@vscode/wasm-wasi';
import { loadProcessHost, type ProcessHost } from './host/processHost';
import { GuestProcess, StdinQueue } from './host/guestProcess';
import { ProgramTerminal } from './host/programTerminal';
import { VscodeGuestFs } from './host/vscodeGuestFs';
import { createGuestWorker } from './host/workerHost';
import { GUEST_WORKSPACE } from './toolchain/guestPaths';
import { runEnvSetting } from './projectConfig';
import { describeUnsupportedImports } from './toolchain/wasiImports';
import { defaultRunEnvironment, GUEST_HOME, GUEST_TMP } from './toolchain/runEnvironment';

// PseudoterminalState is only declared (not exported at runtime) by @vscode/wasm-wasi, so use its values directly.
const STATE_IDLE = 2;
const STATE_BUSY = 3;
const NEWLINE = String.fromCharCode(10);

/** What the abort() helper linked into every build exits with (see toolchain.ts): the Unix code for SIGABRT. */
const ABORT_EXIT_CODE = 134;
/** Conventional code for a process stopped by SIGINT. */
const TERMINATED_EXIT_CODE = 130;

/** Test seam: receives the pseudoterminal instead of opening a real terminal for it. */
export interface RunHost {
	openTerminal?: (pty: ReturnType<ProcessHost['createPseudoterminal']>) => void;
}

/**
 * Works around wasm-wasi-core returning a line typed before the program asked for input without its trailing
 * newline (only lines delivered straight to a waiting read get one), which leaves `cin >> n` waiting for a delimiter.
 */
function terminateTypedAheadLines(pty: object): void {
	const impl = pty as { readline?: () => Promise<string> };
	const original = impl.readline;
	if (typeof original !== 'function') { return; }
	impl.readline = async function (this: unknown) {
		const line = await original.call(this);
		return line.endsWith(NEWLINE) ? line : line + NEWLINE;
	};
}

/** A fresh, empty `/tmp` directory and the persistent home directory, both in extension storage. */
async function prepareScratchDirs(context: vscode.ExtensionContext): Promise<[vscode.Uri, vscode.Uri]> {
	const tmp = vscode.Uri.joinPath(context.globalStorageUri, 'run', 'tmp');
	const home = vscode.Uri.joinPath(context.globalStorageUri, 'run', 'home');
	try { await vscode.workspace.fs.delete(tmp, { recursive: true, useTrash: false }); } catch { /* not there yet */ }
	await vscode.workspace.fs.createDirectory(tmp);
	await vscode.workspace.fs.createDirectory(home);
	return [tmp, home];
}

/** What Run and Debug share: arguments, environment, and the `/workspace`, `/tmp` and `/home/user` mounts. */
export async function processOptions(context: vscode.ExtensionContext, args: string[]): Promise<{ args: string[]; env: Environment; mountPoints: MountPointDescriptor[] }> {
	const [tmp, home] = await prepareScratchDirs(context);
	return {
		args,
		env: defaultRunEnvironment(runEnvSetting()),
		mountPoints: [
			{ kind: 'workspaceFolder' },
			{ kind: 'vscodeFileSystem', uri: tmp, mountPoint: GUEST_TMP },
			{ kind: 'vscodeFileSystem', uri: home, mountPoint: GUEST_HOME },
		],
	};
}

/**
 * Runs a built .wasm under wasm-wasi-core with stdio wired to a new terminal.
 *
 * stdin is the terminal's line mode (wasm-wasi-core echoes, edits and delivers a line per Enter); there
 * is no raw/per-key mode and no EOF key, so programs reading until EOF block until the process is
 * stopped. Ctrl+C or closing the terminal terminates the process. The terminal stays open afterwards,
 * showing the exit code, or `terminated` when stopped that way (the promise then resolves to 130).
 *
 * The program gets `HOME`, `TMPDIR`, `USER` and `LANG` (plus `vscwclang.run.env`), the workspace at `/workspace`, and
 * writable `/tmp` (emptied before every run) and `/home/user` (kept) backed by extension storage.
 *
 * A failed `assert`, `abort()` or `std::terminate` exits with 134 (a helper linked into every build). Other traps
 * (out-of-bounds access, `__builtin_trap`) hang until Ctrl+C because wasm-wasi-core never reports them (vscode-wasm#303).
 */
export async function runProgram(context: vscode.ExtensionContext, program: vscode.Uri, args: string[], host: RunHost = {}): Promise<number> {
	if (vscode.workspace.getConfiguration('vscwclang').get<boolean>('experimental.workerHost', true)) { return runProgramOnWorkerHost(context, program, args, host); }
	const wasm = await loadProcessHost();
	const name = program.path.slice(program.path.lastIndexOf('/') + 1);
	const module = await WebAssembly.compile(await vscode.workspace.fs.readFile(program) as Uint8Array<ArrayBuffer>);
	const unsupported = describeUnsupportedImports(WebAssembly.Module.imports(module));
	if (unsupported !== undefined) { throw new Error(`vscwClang: cannot run ${name}. ${unsupported}`); }
	const pty = wasm.createPseudoterminal();
	terminateTypedAheadLines(pty);
	if (host.openTerminal) {
		host.openTerminal(pty);
	} else {
		vscode.window.createTerminal({ name: `vscwClang: ${name}`, pty }).show(false);
	}
	const process = await wasm.createProcess(name, module, { ...await processOptions(context, args), stdio: pty.stdio });
	let terminated = false;
	const terminate = () => { terminated = true; void process.terminate(); };
	const stop = [pty.onDidCtrlC(terminate), pty.onDidCloseTerminal(terminate)];
	pty.setState(STATE_BUSY);
	let exitCode: number;
	try {
		exitCode = await process.run();
	} finally {
		stop.forEach(d => d.dispose());
		pty.setState(STATE_IDLE);
	}
	// terminate() resolves run() with 0, which would read as success.
	if (terminated) {
		await pty.write(`\r\n[${name} terminated]\r\n`);
		return TERMINATED_EXIT_CODE;
	}
	await pty.write(`\r\n[${name} exited with code ${exitCode}${exitCode === ABORT_EXIT_CODE ? ' (aborted)' : ''}]\r\n`);
	return exitCode;
}

/** Exit code for a program that trapped, as a SIGSEGV would end a native one. */
const TRAPPED_EXIT_CODE = 139;

/**
 * Run on the V2 Worker host (`vscwclang.experimental.workerHost`): same terminal, mounts and environment as
 * `runProgram`, but a trap (out-of-bounds access, divide by zero, `__builtin_trap`, uncaught exception) ends the run
 * with a message and exit code 139 instead of hanging. Ctrl+C or closing the terminal stops the program.
 * Files are saved when the program closes them or ends; see `GuestWasi`.
 */
async function runProgramOnWorkerHost(context: vscode.ExtensionContext, program: vscode.Uri, args: string[], host: RunHost): Promise<number> {
	const name = program.path.slice(program.path.lastIndexOf('/') + 1);
	const module = await WebAssembly.compile(await vscode.workspace.fs.readFile(program) as Uint8Array<ArrayBuffer>);
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder before running.'); }
	const [tmp, home] = await prepareScratchDirs(context);
	const stdin = new StdinQueue();
	const encoder = new TextEncoder();
	let guest: GuestProcess | undefined;
	const terminal = new ProgramTerminal(line => stdin.push(encoder.encode(line)), { onInterrupt: () => guest?.terminate(), onClose: () => guest?.terminate() });
	if (host.openTerminal) {
		host.openTerminal(terminal as never);
	} else {
		vscode.window.createTerminal({ name: `vscwClang: ${name}`, pty: terminal }).show(false);
	}
	const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
	const worker = await createGuestWorker(context);
	guest = new GuestProcess({
		module, args: [name, ...args], env: defaultRunEnvironment(runEnvSetting()),
		preopens: [GUEST_WORKSPACE, GUEST_TMP, GUEST_HOME],
		fs: new VscodeGuestFs([{ guestPath: GUEST_WORKSPACE, uri: folder }, { guestPath: GUEST_TMP, uri: tmp }, { guestPath: GUEST_HOME, uri: home }]),
		stdin,
		onOutput: (fd, data) => terminal.write(decoders[fd].decode(data, { stream: true })),
		createWorker: () => worker,
	});
	const outcome = await guest.run();
	stdin.end();
	switch (outcome.kind) {
		case 'exit':
			terminal.write(`\n[${name} exited with code ${outcome.code}${outcome.code === ABORT_EXIT_CODE ? ' (aborted)' : ''}]\n`);
			return outcome.code;
		case 'trap':
			terminal.write(`\n[${name} trapped: ${outcome.message}]\n`);
			return TRAPPED_EXIT_CODE;
		case 'terminated':
			terminal.write(`\n[${name} terminated]\n`);
			return TERMINATED_EXIT_CODE;
		case 'failed':
			terminal.write(`\n[${name} could not run: ${outcome.message}]\n`);
			throw new Error(`vscwClang: ${name} could not run: ${outcome.message}`);
	}
}
