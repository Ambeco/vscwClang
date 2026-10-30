import * as assert from 'assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { GuestProcess, StdinQueue, type GuestFileSystem, type ProcessOutcome, type WorkerLike } from '../../host/guestProcess';
import { createSharedMemory } from '../../host/sharedMemory';
import { GuestFsError, type GuestDirEntry, type GuestStat } from '../../host/wasiGuest';

const ROOT = process.cwd();
// Resolved from the repo, because this file is bundled into a temp folder with no node_modules.
const { buildSync } = createRequire(join(ROOT, 'package.json'))('esbuild') as typeof import('esbuild');
const FIXTURES = join(ROOT, 'src', 'web', 'test', 'fixtures', 'host');
const decoder = new TextDecoder();

/** The same worker code the browser bundles, with a `worker_threads` endpoint instead of `self`. */
function bundleWorker(entry: string): string {
	const result = buildSync({
		stdin: { contents: entry, resolveDir: join(ROOT, 'src', 'web', 'host'), loader: 'ts' },
		bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
	});
	return result.outputFiles[0].text;
}

const GUEST_WORKER = bundleWorker(`
	import { parentPort } from 'node:worker_threads';
	import { runGuestWorker } from './guestWorker';
	runGuestWorker({ postMessage: (m, t) => parentPort!.postMessage(m, t as never), onMessage: l => { parentPort!.on('message', l); } });
`);

function nodeWorker(code: string): WorkerLike {
	const worker = new Worker(code, { eval: true });
	return {
		postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
		onMessage: listener => { worker.on('message', listener); },
		onError: listener => { worker.on('error', e => listener(e.message)); },
		terminate: () => { void worker.terminate(); },
	};
}

class MemoryFs implements GuestFileSystem {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>(['/', '/workspace', '/tmp']);
	async stat(path: string): Promise<GuestStat> {
		if (this.dirs.has(path)) { return { type: 'dir', size: 0, mtimeMs: 0 }; }
		const file = this.files.get(path);
		if (!file) { throw Object.assign(new Error(`no such file ${path}`), { code: 'ENOENT' }); }
		return { type: 'file', size: file.length, mtimeMs: 0 };
	}
	async readFile(path: string): Promise<Uint8Array> {
		const file = this.files.get(path);
		if (!file) { throw Object.assign(new Error(`no such file ${path}`), { code: 'ENOENT' }); }
		return file;
	}
	async writeFile(path: string, data: Uint8Array): Promise<void> { this.files.set(path, data); }
	async readDirectory(path: string): Promise<GuestDirEntry[]> {
		const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
		return [
			...[...this.files.keys()].filter(f => parent(f) === path).map(f => ({ name: f.slice(path.length + 1), type: 'file' as const })),
			...[...this.dirs].filter(d => d !== path && parent(d) === path).map(d => ({ name: d.slice(path.length + 1), type: 'dir' as const })),
		];
	}
	async createDirectory(path: string): Promise<void> { this.dirs.add(path); }
	async delete(path: string): Promise<void> {
		if (!this.files.delete(path) && !this.dirs.delete(path)) { throw Object.assign(new Error(`no such file ${path}`), { code: 'ENOENT' }); }
	}
	async rename(from: string, to: string): Promise<void> {
		const file = this.files.get(from);
		if (!file) { throw new GuestFsError('ENOENT', from); }
		this.files.delete(from);
		this.files.set(to, file);
	}
}

interface Session { process: GuestProcess; stdin: StdinQueue; out: () => string; err: () => string; fs: MemoryFs; outcome: Promise<ProcessOutcome> }

function start(name: string, args: string[] = [], env: Record<string, string> = {}, terminal = false): Session {
	const bytes = readFileSync(join(FIXTURES, `${name}.wasm`));
	const module = new WebAssembly.Module(bytes);
	const stdin = new StdinQueue();
	const fs = new MemoryFs();
	let out = '';
	let err = '';
	const process = new GuestProcess({
		module, args: [name, ...args], env, preopens: ['/workspace', '/tmp'], terminal, fs, stdin,
		onOutput: (fd, data) => { if (fd === 1) { out += decoder.decode(data); } else { err += decoder.decode(data); } },
		createWorker: () => nodeWorker(GUEST_WORKER),
		createThreadWorker: () => nodeWorker(GUEST_WORKER),
		sharedMemory: createSharedMemory(bytes),
	});
	return { process, stdin, out: () => out, err: () => err, fs, outcome: process.run() };
}

const until = async (condition: () => boolean, what: string) => {
	const began = Date.now();
	while (!condition()) {
		if (Date.now() - began > 10_000) { throw new Error(`timed out waiting for ${what}`); }
		await new Promise(resolve => setTimeout(resolve, 5));
	}
};

suite('GuestProcess over a real Worker', function () {
	this.timeout(30_000);

	test('runs a program: output, args, env and exit code', async () => {
		const s = start('hello', ['x'], { FOO: 'bar' });
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 3 });
		assert.strictEqual(s.out(), 'hello x\nFOO=bar\n');
		assert.strictEqual(s.err(), 'to-stderr\n');
	});

	test('stdin typed later wakes the blocked Worker, and a quit line ends the program', async () => {
		const s = start('echo');
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.strictEqual(s.out(), '', 'nothing is printed before input');
		s.stdin.push(new TextEncoder().encode('first\n'));
		await until(() => s.out().includes('got: first'), 'the first echo');
		s.stdin.push(new TextEncoder().encode('quit\n'));
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 0 });
		assert.strictEqual(s.out(), 'got: first\nbye\n');
	});

	test('ending input makes a blocked read return end of file', async () => {
		const s = start('echo');
		await new Promise(resolve => setTimeout(resolve, 50));
		s.stdin.end();
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 0 });
		assert.strictEqual(s.out(), 'bye\n');
	});

	test('a terminal guest sees isatty and gets line-buffered stdout, so lines arrive before it blocks on input', async () => {
		const s = start('buffered', [], {}, true);
		await until(() => s.out().includes('isatty'), 'the second line before any input');
		assert.strictEqual(s.out(), 'first\nisatty=1,1,1\n');
		s.stdin.push(new TextEncoder().encode('x\n'));
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 0 });
		assert.strictEqual(s.out(), 'first\nisatty=1,1,1\nread\n');
	});

	test('a non-terminal guest (tools, clangd) sees no tty, so libc fully buffers stdout after its first line', async () => {
		const s = start('buffered');
		await until(() => s.out() !== '', 'the first line');
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.strictEqual(s.out(), 'first\n');
		s.stdin.end();
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 0 });
		assert.strictEqual(s.out(), 'first\nisatty=0,0,0\n');
	});

	test('file I/O reaches the host file system', async () => {
		const s = start('fileio');
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 0 });
		assert.strictEqual(decoder.decode(s.fs.files.get('/workspace/out.txt')), 'line one\nline two\nline three\n');
		assert.ok(s.out().includes('entries: out.txt,sub,'), s.out());
		assert.ok(s.out().includes('tmp: writable'));
	});

	for (const [mode, message] of [['oob', /out of bounds/], ['div', /divide by zero/], ['trap', /unreachable/]] as const) {
		test(`trap case "${mode}" ends the run with the engine's message`, async () => {
			const s = start('trap', [mode]);
			const outcome = await s.outcome;
			assert.strictEqual(outcome.kind, 'trap');
			assert.match((outcome as { message: string }).message, message);
			assert.strictEqual(s.out(), 'before\n');
		});
	}

	test('terminate ends a Worker that is blocked reading stdin', async () => {
		const s = start('echo');
		await new Promise(resolve => setTimeout(resolve, 100));
		s.process.terminate();
		assert.deepStrictEqual(await s.outcome, { kind: 'terminated' });
	});

	test('a response larger than one channel chunk arrives intact', async () => {
		const big = new Uint8Array(700_000).map((_, i) => i % 251);
		const module = new WebAssembly.Module(readFileSync(join(FIXTURES, 'hello.wasm')));
		const fs = new MemoryFs();
		fs.files.set('/workspace/big.bin', big);
		const code = bundleWorker(`
			import { parentPort } from 'node:worker_threads';
			import { SyncRpcClient } from './syncChannel';
			const endpoint = { postMessage: (m: unknown, t?: unknown) => parentPort!.postMessage(m, t as never), onMessage: (l: (m: unknown) => void) => { parentPort!.on('message', l); } };
			parentPort!.once('message', (m: any) => {
				const client = new SyncRpcClient(endpoint, m.channel);
				const bytes = client.call('readFile', { path: '/workspace/big.bin' }).bytes;
				let sum = 0; for (const b of bytes) { sum += b; }
				client.call('writeFile', { path: '/workspace/sum.txt' }, new TextEncoder().encode(bytes.length + ':' + sum));
				endpoint.postMessage({ type: 'done', result: { kind: 'exit', code: 0 } });
			});
		`);
		const process = new GuestProcess({ module, args: [], env: {}, preopens: [], fs, stdin: new StdinQueue(), onOutput: () => undefined, createWorker: () => nodeWorker(code) });
		assert.deepStrictEqual(await process.run(), { kind: 'exit', code: 0 });
		const expected = big.reduce((n, b) => n + b, 0);
		assert.strictEqual(decoder.decode(fs.files.get('/workspace/sum.txt')), `700000:${expected}`);
	});

	test('wasi-threads: four pthreads share memory, a mutex counts exactly, and a thread can write to stderr', async () => {
		const s = start('threads');
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 0 });
		assert.strictEqual(s.out(), 'counter = 4000\n');
		assert.ok(s.err().includes('hello from thread 2'), s.err());
	});

	test('wasi-threads: _exit in a thread ends the whole process with that code', async () => {
		const s = start('threads', ['exit']);
		assert.deepStrictEqual(await s.outcome, { kind: 'exit', code: 7 });
	});

	test('a threaded module without sharedMemory fails with a did-you-mean', async () => {
		const module = new WebAssembly.Module(readFileSync(join(FIXTURES, 'threads.wasm')));
		const process = new GuestProcess({ module, args: ['threads'], env: {}, preopens: [], fs: new MemoryFs(), stdin: new StdinQueue(), onOutput: () => undefined, createWorker: () => nodeWorker(GUEST_WORKER) });
		const outcome = await process.run();
		assert.strictEqual(outcome.kind, 'failed');
		assert.match((outcome as { message: string }).message, /sharedMemory/);
	});

	test('createSharedMemory returns undefined for a module that owns its memory', () => {
		assert.strictEqual(createSharedMemory(readFileSync(join(FIXTURES, 'hello.wasm'))), undefined);
		assert.ok(createSharedMemory(readFileSync(join(FIXTURES, 'threads.wasm')))?.buffer instanceof SharedArrayBuffer);
	});

	test('a program that cannot start reports why', async () => {
		const module = new WebAssembly.Module(readFileSync(join(FIXTURES, 'hello.wasm')));
		const code = bundleWorker(`
			import { parentPort } from 'node:worker_threads';
			parentPort!.once('message', () => { throw new Error('boom'); });
		`);
		const process = new GuestProcess({ module, args: [], env: {}, preopens: [], fs: new MemoryFs(), stdin: new StdinQueue(), onOutput: () => undefined, createWorker: () => nodeWorker(code) });
		const outcome = await process.run();
		assert.strictEqual(outcome.kind, 'failed');
		assert.match((outcome as { message: string }).message, /boom/);
	});
});
