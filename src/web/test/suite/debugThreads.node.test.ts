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
