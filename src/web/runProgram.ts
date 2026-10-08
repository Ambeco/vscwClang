import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
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
	openTerminal?: (pty: ReturnType<Wasm['createPseudoterminal']>) => void;
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
	const wasm = await Wasm.load();
	const name = program.path.slice(program.path.lastIndexOf('/') + 1);
	const module = await WebAssembly.compile(await vscode.workspace.fs.readFile(program) as Uint8Array<ArrayBuffer>);
	const unsupported = describeUnsupportedImports(WebAssembly.Module.imports(module));
	if (unsupported !== undefined) { throw new Error(`vscwClang: cannot run ${name}. ${unsupported}`); }
	const pty = wasm.createPseudoterminal();
	terminateTypedAheadLines(pty);
	if (host.openTerminal) {
		host.openTerminal(pty);
	} else {
		vscode.window.createTerminal({ name: `vscwClang: ${name}`, pty }).show(true);
	}
	const [tmp, home] = await prepareScratchDirs(context);
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const process = await wasm.createProcess(name, module, {
		args,
		env: defaultRunEnvironment(settings.get<Record<string, string | null>>('run.env', {})),
		stdio: pty.stdio,
		mountPoints: [
			{ kind: 'workspaceFolder' },
			{ kind: 'vscodeFileSystem', uri: tmp, mountPoint: GUEST_TMP },
			{ kind: 'vscodeFileSystem', uri: home, mountPoint: GUEST_HOME },
		],
	});
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
