import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { nodeReactorThreads } from '../reactorThreads';
import { artifactReactor } from '../artifacts';
import { DebugController, type DebugTarget } from '../../debug/debugController';
import type { PathMapper } from '../../debug/pathMapper';
import { ReactorHost } from '../../debug/reactorHost';
import { StubDebuggee } from '../../debug/stubDebuggee';
import { scanProgram } from '../../debug/wasmScan';
import { DapClient, type DapMessage } from './dapClient';
import { Debuggee } from './stubWorkerHarness';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { GuestProcess, StdinQueue, type GuestFileSystem, type WorkerLike } from '../../host/guestProcess';
import { createSharedMemory } from '../../host/sharedMemory';
import { GuestFsError } from '../../host/wasiGuest';

const REACTOR = artifactReactor();
const PROGRAM = join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'debug', 'stepcallstub.wasm');
const identity: PathMapper = { dapToGuest: p => p, guestToDap: p => p };

const suiteIfFixtures = existsSync(REACTOR) && existsSync(PROGRAM) ? suite : suite.skip;

// Found on vscode.dev: Step In on `total += sq(i);` inside a loop ran the whole call instead of entering sq.
suiteIfFixtures('DebugController stepping into a call from a loop (stepcall.c)', function () {
	this.timeout(120_000);
	const program = new Uint8Array(readFileSync(PROGRAM));
	const scan = scanProgram(program);
	let reactor: ReactorHost;
	let dbg: Debuggee | undefined;
	let client: DapClient & { controller: DebugController };

	suiteSetup(async () => {
		reactor = await ReactorHost.create(readFileSync(REACTOR), undefined, undefined, nodeReactorThreads());
		reactor.createTarget(program);
	});

	setup(() => {
		let controller: DebugController;
		client = new DapClient(message => controller.handleMessage(message)) as DapClient & { controller: DebugController };
		const launch = async (): Promise<DebugTarget> => {
			const worker = new Debuggee(program);
			dbg = worker;
			const session = new StubDebuggee({ send: text => worker.write(text), exited: worker.exited, terminate: () => void worker.terminate(), guardSites: scan.guardSites });
			worker.onStderr = b => session.feedStderr(b);
			worker.onStdout = b => session.feedStdout(b);
			return { session, reactor, program, scan, paths: identity };
		};
		controller = new DebugController({ launch, send: m => client.receive(m as DapMessage) });
		client.controller = controller;
	});
	teardown(async () => { await client.request('disconnect').catch(() => undefined); await dbg?.terminate(); dbg = undefined; });

	const topFrames = async () => (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { name: string; line: number }[];

	test('step in on a call line inside a loop enters the callee at its first body line', async () => {
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', {});
		await client.event('initialized');
		await client.ok('setBreakpoints', { source: { path: 'stepcall.c' }, breakpoints: [{ line: 9 }] });
		await client.ok('configurationDone');
		await client.event('stopped');
		assert.deepStrictEqual((await topFrames())[0].line, 9);
		await client.ok('stepIn', { threadId: 1 });
		await client.event('stopped');
		let frames = await topFrames();
		assert.deepStrictEqual([frames[0].name, frames[0].line], ['sq', 2]);
		// Second iteration: continue to the breakpoint again, then step in again.
		await client.ok('continue', { threadId: 1 });
		await client.event('stopped');
		frames = await topFrames();
		assert.deepStrictEqual([frames[0].name, frames[0].line], ['main', 9]);
		await client.ok('stepIn', { threadId: 1 });
		await client.event('stopped');
		frames = await topFrames();
		assert.deepStrictEqual([frames[0].name, frames[0].line], ['sq', 2], 'second visit to the call line');
	});
});

const THREADED = join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'debug', 'stepcallmtstub.wasm');
const { buildSync } = createRequire(join(process.cwd(), 'package.json'))('esbuild') as typeof import('esbuild');
const GUEST_WORKER = buildSync({
	stdin: {
		contents: `import { parentPort } from 'node:worker_threads';
			import { runGuestWorker } from './guestWorker';
			runGuestWorker({ postMessage: (m, t) => parentPort!.postMessage(m, t as never), onMessage: l => { parentPort!.on('message', l); } });`,
		resolveDir: join(process.cwd(), 'src', 'web', 'host'), loader: 'ts',
	},
	bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const nodeWorker = (): WorkerLike => {
	const worker = new Worker(GUEST_WORKER, { eval: true });
	return {
		postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
		onMessage: listener => { worker.on('message', listener); },
		onError: listener => { worker.on('error', e => listener(e.message)); },
		terminate: () => { void worker.terminate(); },
	};
};
const noFiles: GuestFileSystem = {
	stat: async path => { throw new GuestFsError('ENOENT', path); },
	readFile: async path => { throw new GuestFsError('ENOENT', path); },
	writeFile: async () => undefined,
	readDirectory: async () => [],
	createDirectory: async () => undefined,
	delete: async path => { throw new GuestFsError('ENOENT', path); },
	rename: async from => { throw new GuestFsError('ENOENT', from); },
};

const suiteIfThreaded = existsSync(REACTOR) && existsSync(THREADED) ? suite : suite.skip;

suiteIfThreaded('DebugController stepping into a call from a loop (threaded build)', function () {
	this.timeout(120_000);
	const bytes = new Uint8Array(readFileSync(THREADED));
	const scan = scanProgram(bytes);
	let reactor: ReactorHost;
	let guest: GuestProcess | undefined;
	let client: DapClient & { controller: DebugController };

	suiteSetup(async () => {
		reactor = await ReactorHost.create(readFileSync(REACTOR), undefined, undefined, nodeReactorThreads());
		reactor.createTarget(bytes);
	});
	setup(() => {
		let controller: DebugController;
		client = new DapClient(message => controller.handleMessage(message)) as DapClient & { controller: DebugController };
		const launch = async (): Promise<DebugTarget> => {
			const memory = createSharedMemory(bytes)!;
			const stdin = new StdinQueue();
			let session!: StubDebuggee;
			guest = new GuestProcess({
				module: new WebAssembly.Module(bytes), args: ['stepcall'], env: {}, preopens: [], fs: noFiles, stdin,
				onOutput: (fd, data) => { if (fd === 2) { session.feedStderr(data); } else { session.feedStdout(data); } },
				createWorker: nodeWorker, createThreadWorker: nodeWorker, sharedMemory: memory,
			});
			const exited = guest.run().then(() => 0);
			session = new StubDebuggee({ send: text => stdin.push(new TextEncoder().encode(text)), exited, terminate: () => guest!.terminate(), guardSites: scan.guardSites, memory });
			return { session, reactor, program: bytes, scan, paths: identity };
		};
		controller = new DebugController({ launch, send: m => client.receive(m as DapMessage) });
		client.controller = controller;
	});
	teardown(async () => { await client.request('disconnect').catch(() => undefined); guest?.terminate(); guest = undefined; });

	test('step in on a call line inside a loop enters the callee at its first body line', async () => {
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', {});
		await client.event('initialized');
		await client.ok('setBreakpoints', { source: { path: 'stepcallmt.c' }, breakpoints: [{ line: 9 }] });
		await client.ok('configurationDone');
		await client.event('stopped');
		await client.ok('stepIn', { threadId: 1 });
		await client.event('stopped');
		const frames = (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { name: string; line: number }[];
		assert.deepStrictEqual([frames[0].name, frames[0].line], ['sq', 2]);
	});
});
