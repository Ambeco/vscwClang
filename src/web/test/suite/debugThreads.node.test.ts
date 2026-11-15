import * as assert from 'assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { GuestProcess, StdinQueue, type GuestFileSystem, type WorkerLike } from '../../host/guestProcess';
import { createSharedMemory } from '../../host/sharedMemory';
import { GuestFsError } from '../../host/wasiGuest';
import { StubSession } from '../../debug/stubChannel';
import { scanProgram } from '../../debug/wasmScan';
import { StubDebuggee } from '../../debug/stubDebuggee';
import type { DebuggeeEvent } from '../../debug/debuggeeSession';

const ROOT = process.cwd();
const { buildSync } = createRequire(join(ROOT, 'package.json'))('esbuild') as typeof import('esbuild');
const THREADS = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'threadsstub.wasm');

// threadsstub.wasm is fixtures/debug/threads.c plus debugStub.c on wasm32-wasip1-threads (scripts/build-debug-fixtures.mjs).
const GUEST_WORKER = buildSync({
	stdin: {
		contents: `import { parentPort } from 'node:worker_threads';
			import { runGuestWorker } from './guestWorker';
			runGuestWorker({ postMessage: (m, t) => parentPort!.postMessage(m, t as never), onMessage: l => { parentPort!.on('message', l); } });`,
		resolveDir: join(ROOT, 'src', 'web', 'host'), loader: 'ts',
	},
	bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;

function nodeWorker(): WorkerLike {
	const worker = new Worker(GUEST_WORKER, { eval: true });
	return {
		postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
		onMessage: listener => { worker.on('message', listener); },
		onError: listener => { worker.on('error', e => listener(e.message)); },
		terminate: () => { void worker.terminate(); },
	};
}

const noFiles: GuestFileSystem = {
	stat: async path => { throw new GuestFsError('ENOENT', path); },
	readFile: async path => { throw new GuestFsError('ENOENT', path); },
	writeFile: async () => undefined,
	readDirectory: async () => [],
	createDirectory: async () => undefined,
	delete: async path => { throw new GuestFsError('ENOENT', path); },
	rename: async from => { throw new GuestFsError('ENOENT', from); },
};

const SPIN = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'spinstub.wasm');

/** Runs spinstub.wasm (`main` calls `tick()` forever) under a `StubDebuggee` that has the program's shared memory. */
function startSpin(withMemory: boolean) {
	const bytes = readFileSync(SPIN);
	const scan = scanProgram(bytes);
	const tick = [...scan.module.names].find(([, n]) => n === 'tick')![0];
	const tickGuards = [...scan.guardSites].filter(([, site]) => site.funcIndex === tick).map(([guard]) => guard);
	const memory = createSharedMemory(bytes)!;
	const stdin = new StdinQueue();
	const guest = new GuestProcess({
		module: new WebAssembly.Module(bytes), args: ['spin'], env: {}, preopens: [], fs: noFiles, stdin,
		onOutput: (fd, data) => { if (fd === 2) { debuggee.feedStderr(data); } },
		createWorker: nodeWorker, createThreadWorker: nodeWorker, sharedMemory: memory,
	});
	const exited = guest.run().then(() => 0);
	const debuggee = new StubDebuggee({
		send: text => stdin.push(new TextEncoder().encode(text)), exited, terminate: () => guest.terminate(),
		guardSites: scan.guardSites, memory: withMemory ? memory : undefined,
	});
	void debuggee.start();
	const stops: Extract<DebuggeeEvent, { kind: 'stopped' }>[] = [];
	let notify: (() => void) | undefined;
	debuggee.listener = e => { if (e.kind === 'stopped') { stops.push(e); notify?.(); } };
	const nextStop = async (ms = 15_000) => {
		const deadline = Date.now() + ms;
		while (stops.length === 0) {
			const left = deadline - Date.now();
			assert.ok(left > 0, `no stop within ${ms} ms`);
			await new Promise<void>(resolve => { const t = setTimeout(resolve, left); notify = () => { clearTimeout(t); resolve(); }; });
		}
		return stops.shift()!;
	};
	/** True if no stop arrives within `ms`. */
	const stillRunning = async (ms: number) => { await new Promise(r => setTimeout(r, ms)); return stops.length === 0; };
	return { debuggee, scan, tick, tickGuards, nextStop, stillRunning, stop: () => { guest.terminate(); void debuggee.terminate(); } };
}

suite('breakpoint changes and Pause while the program runs (shared memory)', function () {
	this.timeout(60_000);

	test('a breakpoint set while the program runs stops it, and clearing it while running lets it run on', async () => {
		const p = startSpin(true);
		try {
			assert.strictEqual((await p.nextStop()).reason, 'start');
			assert.deepStrictEqual(p.debuggee.capabilities, { pause: true, breakpointsWhileRunning: true, allStop: true });
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(300), 'the loop runs free');

			await p.debuggee.setBreakpoints(p.tickGuards);
			const hit = await p.nextStop();
			assert.strictEqual(hit.reason, 'breakpoint');
			assert.strictEqual(hit.frames[0].funcIndex, p.tick);

			await p.debuggee.setBreakpoints([]);
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(500), 'a cleared breakpoint no longer stops');
		} finally { p.stop(); }
	});

	test('Pause stops a busy loop with reason "pause" and a stack', async () => {
		const p = startSpin(true);
		try {
			await p.nextStop();
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(200));
			await p.debuggee.pause();
			const stop = await p.nextStop();
			assert.strictEqual(stop.reason, 'pause');
			assert.ok(stop.frames.length >= 1, 'the paused thread has a stack');
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(300), 'a pause is consumed by its stop');
		} finally { p.stop(); }
	});

	test('a pause racing a breakpoint stop does not fire again after the resume', async () => {
		const p = startSpin(true);
		try {
			await p.nextStop();
			await p.debuggee.resume('continue');
			await p.debuggee.setBreakpoints(p.tickGuards);
			await p.debuggee.pause();
			const first = await p.nextStop();
			assert.ok(first.reason === 'breakpoint' || first.reason === 'pause');
			await p.debuggee.setBreakpoints([]);
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(500), 'no leftover pause request');
		} finally { p.stop(); }
	});

	test('without the program\'s shared memory the old rules hold', async () => {
		const p = startSpin(false);
		try {
			await p.nextStop();
			assert.deepStrictEqual(p.debuggee.capabilities, { pause: false, breakpointsWhileRunning: false, allStop: false });
			await assert.rejects(p.debuggee.pause(), /vscwclang\.threads/);
			await p.debuggee.resume('continue');
			await assert.rejects(p.debuggee.setBreakpoints(p.tickGuards), /while the program is running/);
		} finally { p.stop(); }
	});

	test('breakpoints cannot be written before the stub has started (memory initialisation would erase them)', async () => {
		const p = startSpin(true);
		try {
			await assert.rejects(p.debuggee.setBreakpoints(p.tickGuards), /before the program has reached its debug stub/);
			await p.nextStop();
		} finally { p.stop(); }
	});
});

suite('debugging a threaded program (real stub, wasi-threads Workers)', function () {
	this.timeout(60_000);

	test('a breakpoint in a thread function stops on that thread with its own stack, and main stops as thread 1', async () => {
		const bytes = readFileSync(THREADS);
		const scan = scanProgram(bytes);
		const guardsOf = (name: string) => {
			const index = [...scan.module.names].find(([, n]) => n === name)?.[0];
			assert.notStrictEqual(index, undefined, `${name} is in the name section`);
			return { index: index!, guards: [...scan.guardSites].filter(([, site]) => site.funcIndex === index).map(([guard]) => guard) };
		};
		const work = guardsOf('work'), worker = guardsOf('worker'), main = guardsOf('__original_main');

		let stdout = '';
		const decoder = new TextDecoder();
		const stdin = new StdinQueue();
		const session = new StubSession(text => stdin.push(new TextEncoder().encode(text)), () => undefined);
		const guest = new GuestProcess({
			module: new WebAssembly.Module(bytes), args: ['threads'], env: {}, preopens: [], fs: noFiles, stdin,
			onOutput: (fd, data) => { if (fd === 1) { stdout += decoder.decode(data, { stream: true }); } else { session.onStderr(data); } },
			createWorker: nodeWorker, createThreadWorker: nodeWorker, sharedMemory: createSharedMemory(bytes),
		});
		const outcome = guest.run();
		try {
			assert.strictEqual((await session.nextStop(15_000)).reason, 'start');
			await session.setBreakpoints([...main.guards, ...work.guards]);
			await session.resume('go');

			const first = await session.nextStop(15_000);
			assert.deepStrictEqual([first.reason, first.threadId], ['breakpoint', 1]);
			assert.strictEqual(scan.guardSites.get(first.frames[0].guard)?.funcIndex, main.index);

			await session.setBreakpoints(work.guards);
			await session.resume('go');
			const inThread = await session.nextStop(15_000);
			assert.strictEqual(inThread.reason, 'breakpoint');
			assert.notStrictEqual(inThread.threadId, 1, 'work() runs on the created thread');
			assert.deepStrictEqual(inThread.frames.map(f => scan.guardSites.get(f.guard)?.funcIndex), [work.index, worker.index]);

			await session.setBreakpoints([]);
			await session.resume('go');
			assert.deepStrictEqual(await outcome, { kind: 'exit', code: 0 });
			assert.strictEqual(stdout, 'result=41\n');
		} finally {
			guest.terminate();
			session.close();
		}
	});
});
