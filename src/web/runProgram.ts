import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { describeUnsupportedImports } from './toolchain/wasiImports';

// PseudoterminalState is only declared (not exported at runtime) by @vscode/wasm-wasi, so use its values directly.
const STATE_IDLE = 2;
const STATE_BUSY = 3;

/** What the abort() helper linked into every build exits with (see toolchain.ts): the Unix code for SIGABRT. */
const ABORT_EXIT_CODE = 134;
/** Conventional code for a process stopped by SIGINT. */
const TERMINATED_EXIT_CODE = 130;

/**
 * Runs a built .wasm under wasm-wasi-core with stdio wired to a new terminal.
 *
 * stdin is the terminal's line mode (wasm-wasi-core echoes, edits and delivers a line per Enter); there
 * is no raw/per-key mode and no EOF key, so programs reading until EOF block until the process is
 * stopped. Ctrl+C or closing the terminal terminates the process. The terminal stays open afterwards,
 * showing the exit code, or `terminated` when stopped that way (the promise then resolves to 130).
 *
 * A failed `assert`, `abort()` or `std::terminate` exits with 134 (a helper linked into every build). Other traps
 * (out-of-bounds access, `__builtin_trap`) hang until Ctrl+C because wasm-wasi-core never reports them (vscode-wasm#303).
 */
export async function runProgram(program: vscode.Uri, args: string[]): Promise<number> {
	const wasm = await Wasm.load();
	const name = program.path.slice(program.path.lastIndexOf('/') + 1);
	const module = await WebAssembly.compile(await vscode.workspace.fs.readFile(program) as Uint8Array<ArrayBuffer>);
	const unsupported = describeUnsupportedImports(WebAssembly.Module.imports(module));
	if (unsupported !== undefined) { throw new Error(`vscwClang: cannot run ${name}. ${unsupported}`); }
	const pty = wasm.createPseudoterminal();
	const terminal = vscode.window.createTerminal({ name: `vscwClang: ${name}`, pty });
	terminal.show(true);
	const process = await wasm.createProcess(name, module, {
		args,
		stdio: pty.stdio,
		mountPoints: [{ kind: 'workspaceFolder' }],
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
