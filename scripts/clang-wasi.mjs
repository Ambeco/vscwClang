// Runs a toolchain .wasm (clang.wasm) under node:wasi in a worker thread, for scripts that need the compiler
// outside the extension (PCH generation in make-toolchain-dist.mjs, experiments).
import { WASI } from 'node:wasi';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { openSync, closeSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (!isMainThread && workerData?.clangWasi) {
	const { module, args, preopens, stdoutFd, stderrFd } = workerData;
	const wasi = new WASI({ version: 'preview1', args, returnOnExit: true, preopens, stdout: stdoutFd, stderr: stderrFd, env: {} });
	let code;
	try {
		code = wasi.start(await WebAssembly.instantiate(module, wasi.getImportObject()));
	} catch (e) {
		code = 139;
		writeFileSync(stderrFd, `crashed inside WebAssembly: ${e?.message ?? e}\n`);
	}
	parentPort.postMessage({ code });
	process.exit(0);
}

/**
 * Runs `args` (argv[0] first) in `module` with the guest-path -> host-directory `preopens`.
 * Resolves to { code, stdout (Buffer), stderr (string), ms }.
 */
export async function runWasi(module, args, preopens) {
	const dir = mkdtempSync(join(tmpdir(), 'clang-wasi-'));
	try {
		const outPath = join(dir, 'out'), errPath = join(dir, 'err');
		const stdoutFd = openSync(outPath, 'w'), stderrFd = openSync(errPath, 'w');
		const started = performance.now();
		const worker = new Worker(new URL(import.meta.url), { workerData: { clangWasi: true, module, args, preopens, stdoutFd, stderrFd } });
		const code = await new Promise((resolve, reject) => {
			worker.once('message', m => resolve(m.code));
			worker.once('error', reject);
		});
		const ms = performance.now() - started;
		closeSync(stdoutFd); closeSync(stderrFd);
		return { code, stdout: readFileSync(outPath), stderr: readFileSync(errPath, 'utf8'), ms };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
