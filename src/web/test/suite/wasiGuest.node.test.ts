import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuestFsError, GuestWasi, type GuestDirEntry, type GuestResult, type GuestServices, type GuestStat } from '../../host/wasiGuest';

/** In-memory `GuestServices` standing in for the extension host. */
class FakeServices implements GuestServices {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>(['/', '/workspace', '/tmp']);
	readonly stdout: number[] = [];
	readonly stderr: number[] = [];
	stdin: string[] = [];
	sleeps: number[] = [];

	readStdin(maxBytes: number): Uint8Array {
		const next = this.stdin.shift();
		if (next === undefined) { return new Uint8Array(0); }
		const bytes = new TextEncoder().encode(next);
		if (bytes.length > maxBytes) { this.stdin.unshift(new TextDecoder().decode(bytes.subarray(maxBytes))); }
		return bytes.subarray(0, maxBytes);
	}
	writeOutput(fd: 1 | 2, data: Uint8Array): void { (fd === 1 ? this.stdout : this.stderr).push(...data); }
	stat(path: string): GuestStat {
		if (this.dirs.has(path)) { return { type: 'dir', size: 0, mtimeMs: 0 }; }
		const file = this.files.get(path);
		if (!file) { throw new GuestFsError('ENOENT', path); }
		return { type: 'file', size: file.length, mtimeMs: 0 };
	}
	readFile(path: string): Uint8Array { return this.files.get(path) ?? (() => { throw new GuestFsError('ENOENT', path); })(); }
	writeFile(path: string, data: Uint8Array): void {
		if (!this.dirs.has(parent(path))) { throw new GuestFsError('ENOENT', path); }
		this.files.set(path, data);
	}
	readDirectory(path: string): GuestDirEntry[] {
		if (!this.dirs.has(path)) { throw new GuestFsError('ENOTDIR', path); }
		return [
			...[...this.files.keys()].filter(f => parent(f) === path).map(f => ({ name: f.slice(path.length + (path === '/' ? 0 : 1)), type: 'file' as const })),
			...[...this.dirs].filter(d => d !== path && parent(d) === path).map(d => ({ name: d.slice(path.length + (path === '/' ? 0 : 1)), type: 'dir' as const })),
		];
	}
	createDirectory(path: string): void {
		if (this.dirs.has(path) || this.files.has(path)) { throw new GuestFsError('EEXIST', path); }
		this.dirs.add(path);
	}
	delete(path: string): void {
		if (!this.files.delete(path) && !this.dirs.delete(path)) { throw new GuestFsError('ENOENT', path); }
	}
	rename(from: string, to: string): void {
		const file = this.files.get(from);
		if (!file) { throw new GuestFsError('ENOENT', from); }
		this.files.delete(from);
		this.files.set(to, file);
	}
	sleep(ms: number): void { this.sleeps.push(ms); }
	get out(): string { return new TextDecoder().decode(new Uint8Array(this.stdout)); }
	get err(): string { return new TextDecoder().decode(new Uint8Array(this.stderr)); }
}

const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

const fixtureDir = join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'host');
const modules = new Map<string, WebAssembly.Module>();

function run(name: string, services: FakeServices, args: string[] = [], env: Record<string, string> = {}): GuestResult {
	let module = modules.get(name);
	if (!module) { module = new WebAssembly.Module(readFileSync(join(fixtureDir, `${name}.wasm`))); modules.set(name, module); }
	const guest = new GuestWasi({ args: [name, ...args], env, preopens: ['/workspace', '/tmp'], services });
	const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: guest.imports });
	return guest.start(instance);
}

suite('GuestWasi', () => {
	test('stdout, stderr, args, env and the exit code', () => {
		const s = new FakeServices();
		assert.deepStrictEqual(run('hello', s, ['a', 'b'], { FOO: 'bar' }), { kind: 'exit', code: 3 });
		assert.strictEqual(s.out, 'hello a b\nFOO=bar\n');
		assert.strictEqual(s.err, 'to-stderr\n');
		assert.deepStrictEqual(run('hello', new FakeServices(), ['exit7']), { kind: 'exit', code: 7 });
	});

	test('stdin reads deliver lines as they arrive and end at EOF', () => {
		const s = new FakeServices();
		s.stdin = ['one\n', 'two\n', 'quit\n'];
		assert.deepStrictEqual(run('echo', s), { kind: 'exit', code: 0 });
		assert.strictEqual(s.out, 'got: one\ngot: two\nbye\n');
		const eof = new FakeServices();
		eof.stdin = ['only\n'];
		run('echo', eof);
		assert.strictEqual(eof.out, 'got: only\nbye\n');
	});

	test('file I/O through the preopens: write, append, read, stat, directories, rename, unlink, missing files', () => {
		const s = new FakeServices();
		assert.deepStrictEqual(run('fileio', s), { kind: 'exit', code: 0 });
		assert.strictEqual(s.out, [
			'read 29 bytes: line one', 'line two', 'line three', 'size=29',
			'entries: out.txt,sub,', 'missing: absent', 'tmp: writable', '',
		].join('\n'));
		assert.strictEqual(new TextDecoder().decode(s.files.get('/workspace/out.txt')), 'line one\nline two\nline three\n');
		assert.ok(s.files.has('/tmp/scratch.txt'));
		assert.ok(!s.dirs.has('/workspace/sub'), 'rmdir removed the directory');
		assert.strictEqual(s.err, '');
	});

	for (const [mode, message] of [['oob', /out of bounds/], ['div', /divide by zero/], ['trap', /unreachable/]] as const) {
		test(`trap case "${mode}" is reported, not hung, and output so far is kept`, () => {
			const s = new FakeServices();
			const result = run('trap', s, [mode]);
			assert.strictEqual(result.kind, 'trap');
			assert.match((result as { message: string }).message, message);
			assert.strictEqual(s.out, 'before\n');
		});
	}

	test('abort() traps (unreachable) when no abort shim is linked', () => {
		const result = run('trap', new FakeServices(), ['abort']);
		assert.ok(result.kind === 'trap' || (result.kind === 'exit' && result.code !== 0), JSON.stringify(result));
	});

	test('runaway recursion is reported as a trap', () => {
		const result = run('trap', new FakeServices(), ['stack']);
		assert.strictEqual(result.kind, 'trap');
		assert.match((result as { message: string }).message, /call stack|memory access|unreachable/i);
	});

	test('a path cannot climb out of its preopen', () => {
		const s = new FakeServices();
		s.files.set('/secret.txt', new Uint8Array([1]));
		const guest = new GuestWasi({ args: ['x'], env: {}, preopens: ['/workspace'], services: s });
		const memory = new WebAssembly.Memory({ initial: 1 });
		(guest as unknown as { memory: WebAssembly.Memory }).memory = memory;
		const path = new TextEncoder().encode('../secret.txt');
		new Uint8Array(memory.buffer).set(path, 100);
		const pathOpen = guest.imports.path_open as (...a: unknown[]) => number;
		const errno = pathOpen(3, 0, 100, path.length, 0, 0n, 0n, 0, 200);
		assert.strictEqual(errno, 76, 'ENOTCAPABLE');
	});
});
