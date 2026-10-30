// Runs a toolchain .wasm (clang.wasm) under node:wasi in a worker thread, for scripts that need the compiler
// outside the extension (PCH generation in make-toolchain-dist.mjs, experiments).
//
// A threaded build (it imports `env.memory` and `wasi.thread-spawn`) gets a shared memory and one worker_threads
// Worker per spawned thread. node:wasi insists on an exported `memory`, so it is handed a duck-typed instance
// (`fakeInstance`); the threads are not WASI "commands", so their copy has `_start` removed.
import { WASI } from 'node:wasi';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { openSync, closeSync, readFileSync, writeFileSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Min/max pages and sharedness of the module's imported `env.memory`, parsed from the raw import section because
 * `WebAssembly.Module.imports` does not expose limits. Returns undefined for a module that owns its memory.
 */
function importedMemoryLimits(bytes) {
	let i = 8;
	const u32 = () => {
		let v = 0, shift = 0;
		for (;;) {
			const b = bytes[i++];
			v |= (b & 0x7f) << shift;
			if (!(b & 0x80)) { return v >>> 0; }
			shift += 7;
		}
	};
	while (i < bytes.length) {
		const sectionId = bytes[i++];
		const size = u32();
		const end = i + size;
		if (sectionId === 2) {
			const count = u32();
			for (let n = 0; n < count; n++) {
				const moduleLen = u32();
				i += moduleLen;
				const nameLen = u32();
				const name = Buffer.from(bytes.subarray(i, i + nameLen)).toString();
				i += nameLen;
				const kind = bytes[i++];
				if (kind === 2) {
					const flags = bytes[i++];
					const min = u32();
					const max = (flags & 1) ? u32() : undefined;
					if (name === 'memory') { return { min, max, shared: !!(flags & 2) }; }
				} else if (kind === 0) { u32(); }
				else if (kind === 1) { i++; const f = bytes[i++]; u32(); if (f & 1) { u32(); } }
				else if (kind === 3) { i += 2; }
			}
		}
		i = end;
	}
	return undefined;
}

function fakeInstance(instance, memory, forThread) {
	const exports = { ...instance.exports, memory };
	if (forThread) { delete exports._start; }
	return { exports };
}

// node:wasi blocks a worker in poll_oneoff for a clock sleep and Worker.terminate() cannot interrupt that; Atomics.wait can be.
function interruptibleClockSleep(imports, memory) {
	const original = imports.poll_oneoff;
	const cell = new Int32Array(new SharedArrayBuffer(4));
	imports.poll_oneoff = (inPtr, outPtr, nsubs, neventsPtr) => {
		const dv = new DataView(memory.buffer);
		if (nsubs !== 1 || dv.getUint8(inPtr + 8) !== 0) { return original(inPtr, outPtr, nsubs, neventsPtr); }
		const clockId = dv.getUint32(inPtr + 16, true);
		const timeoutNs = dv.getBigUint64(inPtr + 24, true);
		let waitNs = timeoutNs;
		if ((dv.getUint16(inPtr + 40, true) & 1) !== 0) {
			const nowNs = clockId === 0 ? BigInt(Date.now()) * 1000000n : process.hrtime.bigint();
			waitNs = timeoutNs > nowNs ? timeoutNs - nowNs : 0n;
		}
		const ms = Number(waitNs) / 1e6;
		if (ms > 0) { Atomics.wait(cell, 0, 0, ms); }
		dv.setBigUint64(outPtr, dv.getBigUint64(inPtr, true), true);
		dv.setUint16(outPtr + 8, 0, true);
		dv.setUint8(outPtr + 10, 0);
		dv.setUint32(neventsPtr, 1, true);
		return 0;
	};
}

/** Builds the import object for the main instance or a thread; `spawn` is the `wasi.thread-spawn` implementation. */
function makeImports(config, memory, tidCounter) {
	const { module, preopens, stdoutFd, stderrFd } = config;
	const wasi = new WASI({ version: 'preview1', args: config.args, returnOnExit: true, preopens, stdout: stdoutFd, stderr: stderrFd, env: {} });
	const imports = wasi.getImportObject();
	if (!memory) { return { wasi, imports }; }
	interruptibleClockSleep(imports.wasi_snapshot_preview1, memory);
	imports.env = { memory };
	imports.wasi = {
		'thread-spawn': (startArg) => {
			const tid = Atomics.add(tidCounter, 0, 1);
			const worker = new Worker(new URL(import.meta.url), { workerData: { clangWasiThread: true, ...config, module, memory, tid, startArg, tidCounterBuffer: tidCounter.buffer } });
			worker.on('error', (e) => writeSync(stderrFd, `[thread ${tid}] worker error: ${e?.stack ?? e}\n`));
			return tid;
		},
	};
	return { wasi, imports };
}

if (!isMainThread && workerData?.clangWasi) {
	const { module, bytes, stderrFd } = workerData;
	let code;
	try {
		const limits = importedMemoryLimits(bytes);
		let memory, tidCounter;
		if (limits) {
			if (!limits.shared || limits.max === undefined) { throw new Error('threaded module needs a shared, bounded imported memory (-Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=...)'); }
			memory = new WebAssembly.Memory({ initial: limits.min, maximum: limits.max, shared: true });
			tidCounter = new Int32Array(new SharedArrayBuffer(4));
			Atomics.store(tidCounter, 0, 1);
		}
		const { wasi, imports } = makeImports(workerData, memory, tidCounter);
		const instance = await WebAssembly.instantiate(module, imports);
		code = wasi.start(memory ? fakeInstance(instance, memory, false) : instance);
	} catch (e) {
		code = 139;
		writeFileSync(stderrFd, `crashed inside WebAssembly: ${e?.message ?? e}\n`);
	}
	parentPort.postMessage({ code });
	process.exit(0);
}

if (!isMainThread && workerData?.clangWasiThread) {
	const { module, memory, tid, startArg, tidCounterBuffer, stderrFd } = workerData;
	try {
		const { wasi, imports } = makeImports(workerData, memory, new Int32Array(tidCounterBuffer));
		const instance = await WebAssembly.instantiate(module, imports);
		wasi.finalizeBindings(fakeInstance(instance, memory, true));
		instance.exports.wasi_thread_start(tid, startArg);
	} catch (e) {
		writeSync(stderrFd, `[thread ${tid}] trapped: ${e?.message ?? e}\n`);
	}
}

/**
 * Runs `args` (argv[0] first) in `module` with the guest-path -> host-directory `preopens`. `bytes` is the module's
 * binary; it is needed only for a threaded module (to read its memory limits).
 * Resolves to { code, stdout (Buffer), stderr (string), ms }.
 */
export async function runWasi(module, args, preopens, bytes) {
	const dir = mkdtempSync(join(tmpdir(), 'clang-wasi-'));
	try {
		const outPath = join(dir, 'out'), errPath = join(dir, 'err');
		const stdoutFd = openSync(outPath, 'w'), stderrFd = openSync(errPath, 'w');
		const started = performance.now();
		const worker = new Worker(new URL(import.meta.url), { workerData: { clangWasi: true, module, bytes, args, preopens, stdoutFd, stderrFd } });
		const code = await new Promise((resolve, reject) => {
			worker.once('message', m => resolve(m.code));
			worker.once('error', reject);
		});
		const ms = performance.now() - started;
		await worker.terminate(); // also ends threads still parked in a wait
		closeSync(stdoutFd); closeSync(stderrFd);
		return { code, stdout: readFileSync(outPath), stderr: readFileSync(errPath, 'utf8'), ms };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
