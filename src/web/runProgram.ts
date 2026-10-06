import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';

// PseudoterminalState is only declared (not exported at runtime) by @vscode/wasm-wasi, so use its values directly.
const STATE_IDLE = 2;
const STATE_BUSY = 3;

/**
 * Runs a built .wasm under wasm-wasi-core with stdio wired to a new terminal.
 *
 * stdin is the terminal's line mode (wasm-wasi-core echoes, edits and delivers a line per Enter); there
 * is no raw/per-key mode and no EOF key, so programs reading until EOF block until the process is
 * stopped. Ctrl+C or closing the terminal terminates the process. The terminal stays open afterwards,
 * showing the exit code.
 */
export async function runProgram(program: vscode.Uri, args: string[]): Promise<number> {
	const wasm = await Wasm.load();
	const name = program.path.slice(program.path.lastIndexOf('/') + 1);
	const pty = wasm.createPseudoterminal();
	const terminal = vscode.window.createTerminal({ name: `vscwClang: ${name}`, pty });
	terminal.show(true);
	const module = await WebAssembly.compile(await vscode.workspace.fs.readFile(program) as Uint8Array<ArrayBuffer>);
	const process = await wasm.createProcess(name, module, {
		args,
		stdio: pty.stdio,
		mountPoints: [{ kind: 'workspaceFolder' }],
	});
	const stop = [pty.onDidCtrlC(() => { void process.terminate(); }), pty.onDidCloseTerminal(() => { void process.terminate(); })];
	pty.setState(STATE_BUSY);
	let exitCode: number;
	try {
		exitCode = await process.run();
	} finally {
		stop.forEach(d => d.dispose());
		pty.setState(STATE_IDLE);
	}
	await pty.write(`\r\n[${name} exited with code ${exitCode}]\r\n`);
	return exitCode;
}
