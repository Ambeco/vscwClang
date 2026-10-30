import * as vscode from 'vscode';
import { GuestProcess, StdinQueue } from './host/guestProcess';
import { ProgramTerminal } from './host/programTerminal';
import { VscodeGuestFs, type GuestMount } from './host/vscodeGuestFs';
import { sharedMemoryLimits } from './host/sharedMemory';
import { createGuestWorker, threadOptions } from './host/workerHost';
import { GUEST_WORKSPACE } from './toolchain/guestPaths';
import { runEnvSetting } from './projectConfig';
import { defaultRunEnvironment, GUEST_HOME, GUEST_TMP } from './toolchain/runEnvironment';

/** What the abort() helper linked into every build exits with (see toolchain.ts): the Unix code for SIGABRT. */
const ABORT_EXIT_CODE = 134;
/** Conventional code for a process stopped by SIGINT. */
const TERMINATED_EXIT_CODE = 130;

/** Test seam: receives the pseudoterminal instead of opening a real terminal for it. */
export interface RunHost {
	openTerminal?: (pty: ProgramTerminal) => void;
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

/** The user-program environment on the Worker host: `/workspace`, `/tmp` and `/home/user` mounts, `HOME`, `TMPDIR`, `USER`, `LANG`, and stdio as a terminal. Shared by Run and Debug. */
export async function workerProgramEnvironment(context: vscode.ExtensionContext): Promise<{ env: Record<string, string>; mounts: GuestMount[]; terminal: true }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder before running or debugging.'); }
	const [tmp, home] = await prepareScratchDirs(context);
	return {
		env: defaultRunEnvironment(runEnvSetting()),
		mounts: [{ guestPath: GUEST_WORKSPACE, uri: folder }, { guestPath: GUEST_TMP, uri: tmp }, { guestPath: GUEST_HOME, uri: home }],
		terminal: true,
	};
}

/** Exit code for a program that trapped, as a SIGSEGV would end a native one. */
const TRAPPED_EXIT_CODE = 139;

/**
 * Runs a built .wasm on the Worker host with stdio wired to a new terminal.
 *
 * Ctrl+C or closing the terminal stops the program (exit code 130, `terminated`); Ctrl+D ends stdin. The terminal
 * stays open afterwards, showing the exit code. A trap (out-of-bounds access, divide by zero, `__builtin_trap`,
 * uncaught exception) ends the run with a message and exit code 139. A failed `assert`, `abort()` or
 * `std::terminate` exits with 134 (a helper linked into every build). Files are saved when the program closes
 * them or ends; see `GuestWasi`.
 *
 * The program gets `HOME`, `TMPDIR`, `USER` and `LANG` (plus `vscwclang.run.env`), the workspace at `/workspace`, and
 * writable `/tmp` (emptied before every run) and `/home/user` (kept) backed by extension storage.
 */
export async function runProgram(context: vscode.ExtensionContext, program: vscode.Uri, args: string[], host: RunHost = {}): Promise<number> {
	const name = program.path.slice(program.path.lastIndexOf('/') + 1);
	const bytes = await vscode.workspace.fs.readFile(program) as Uint8Array<ArrayBuffer>;
	const module = await WebAssembly.compile(bytes);
	const { env, mounts, terminal: isTerminal } = await workerProgramEnvironment(context);
	const stdin = new StdinQueue();
	const encoder = new TextEncoder();
	let guest: GuestProcess | undefined;
	const terminal = new ProgramTerminal(line => stdin.push(encoder.encode(line)), { onInterrupt: () => guest?.terminate(), onClose: () => guest?.terminate(), onEof: () => stdin.end() });
	if (host.openTerminal) {
		host.openTerminal(terminal);
	} else {
		vscode.window.createTerminal({ name: `vscwClang: ${name}`, pty: terminal }).show(false);
	}
	const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
	const worker = await createGuestWorker(context);
	guest = new GuestProcess({
		module, args: [name, ...args], env,
		preopens: mounts.map(m => m.guestPath),
		terminal: isTerminal,
		fs: new VscodeGuestFs(mounts),
		stdin,
		onOutput: (fd, data) => terminal.write(decoders[fd].decode(data, { stream: true })),
		createWorker: () => worker,
		...threadOptions(context, sharedMemoryLimits(bytes)),
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
