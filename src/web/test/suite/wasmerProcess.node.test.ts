import * as assert from 'assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWasmerProcess, wasmerTrapMessage, type WasmerLike, type WasmerProcessLike, type WasmerSandboxLike } from '../../host/wasmerProcess';
import { skipDefaultFolders, type FileTree } from '../../host/workspaceSync';

const decoder = new TextDecoder();

/** A sandbox folder in memory, with the `fs` shape of the SDK. */
function fakeSandbox(proc: (calls: { args: readonly string[]; cwd?: string; env?: Record<string, string> }) => WasmerProcessLike, files: Map<string, Uint8Array>): WasmerSandboxLike {
	return {
		fs: {
			async writeFile(path, data) { files.set(path, data); },
			async readFile(path) { const d = files.get(path); if (!d) { throw new Error(`no ${path}`); } return d; },
			async readDir(path) {
				const prefix = `${path}/`;
				const seen = new Map<string, 'file' | 'directory'>();
				for (const f of files.keys()) { if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); const i = rest.indexOf('/'); seen.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'directory'); } }
				return [...seen].map(([name, kind]) => ({ name, kind }));
			},
			async mkdir() { /* implied by file paths */ },
			async remove(path) { for (const f of [...files.keys()]) { if (f === path || f.startsWith(`${path}/`)) { files.delete(f); } } },
		},
		command: (_sel, args = [], options) => ({ spawn: async () => proc({ args, ...options }) }),
		close: async () => undefined,
	};
}

function asyncChunks(...chunks: string[]): AsyncIterable<Uint8Array> {
	return (async function* () { for (const c of chunks) { yield new TextEncoder().encode(c); } })();
}

interface Script { stdout?: string[]; stderr?: string[]; exitCode?: number; reason?: string; throws?: Error; onWait?: () => Promise<void>; written?: Uint8Array[] }

function fakeWasmer(script: Script, files = new Map<string, Uint8Array>(), seen: { args?: readonly string[]; cwd?: string; env?: Record<string, string>; stdinClosed?: boolean } = {}): WasmerLike {
	return {
		packages: { load: async () => ({ commands: ['main'], entrypoint: 'main', command: (n: string) => n }) },
		createSandbox: async () => fakeSandbox(c => {
			seen.args = c.args; seen.cwd = c.cwd; seen.env = c.env;
			return {
				stdin: { write: async d => { script.written?.push(d); }, close: async () => { seen.stdinClosed = true; } },
				stdout: asyncChunks(...(script.stdout ?? [])), stderr: asyncChunks(...(script.stderr ?? [])),
				async wait() { await script.onWait?.(); if (script.throws) { throw script.throws; } return { exitCode: script.exitCode ?? 0, reason: script.reason ?? 'exited' }; },
				terminate: async () => undefined,
			};
		}, files),
	};
}

const base = { name: 'prog', bytes: new Uint8Array(), args: ['a', 'b'], env: { HOME: '/home/user' }, cwd: '/workspace' };

suite('wasmerProcess (fake SDK)', () => {
	test('wasmerTrapMessage extracts the engine message and ignores other errors', () => {
		assert.strictEqual(wasmerTrapMessage(new Error('command execution failed: RuntimeError: js: memory access out of bounds\nRuntimeError: memory access out of bounds\n at x')), 'memory access out of bounds');
		assert.strictEqual(wasmerTrapMessage(new Error('RuntimeError: unreachable')), 'unreachable');
		assert.strictEqual(wasmerTrapMessage(new Error('package not found')), undefined);
	});

	test('passes arguments, cwd and environment, forwards output and returns the exit code', async () => {
		const seen: { args?: readonly string[]; cwd?: string; env?: Record<string, string> } = {};
		const p = createWasmerProcess(fakeWasmer({ stdout: ['hi ', 'there\n'], stderr: ['warn\n'], exitCode: 7 }, new Map(), seen), base);
		let out = '', err = '';
		p.stdout.onData(d => { out += decoder.decode(d); });
		p.stderr.onData(d => { err += decoder.decode(d); });
		assert.strictEqual(await p.run(), 7);
		assert.strictEqual(out, 'hi there\n');
		assert.strictEqual(err, 'warn\n');
		assert.deepStrictEqual(seen, { args: ['a', 'b'], cwd: '/workspace', env: { HOME: '/home/user' } });
	});

	test('output emitted before a listener attaches is not lost', async () => {
		const p = createWasmerProcess(fakeWasmer({ stdout: ['early\n'] }), base);
		await p.run();
		let out = '';
		p.stdout.onData(d => { out += decoder.decode(d); });
		assert.strictEqual(out, 'early\n');
	});

	test('a trap becomes outcome trap, and run() reports 139 with the message on stderr', async () => {
		const trap = new Error('command execution failed: RuntimeError: js: divide by zero');
		const outcome = await createWasmerProcess(fakeWasmer({ throws: trap }), base).runToOutcome();
		assert.deepStrictEqual(outcome, { kind: 'trap', message: 'divide by zero' });
		const p = createWasmerProcess(fakeWasmer({ throws: trap }), base);
		let err = '';
		p.stderr.onData(d => { err += decoder.decode(d); });
		assert.strictEqual(await p.run(), 139);
		assert.match(err, /prog: crashed inside WebAssembly: divide by zero/);
	});

	test('an SDK error that is not a trap is a failed outcome and run() rejects with it', async () => {
		const p = createWasmerProcess(fakeWasmer({ throws: new Error('sandbox closed') }), base);
		await assert.rejects(() => p.run(), /prog could not run: sandbox closed/);
	});

	test('terminate() before start never starts the program and reports 130', async () => {
		let started = false;
		const w = fakeWasmer({ onWait: async () => { started = true; } });
		const p = createWasmerProcess(w, base);
		await p.terminate();
		assert.strictEqual(await p.run(), 130);
		assert.strictEqual(started, false);
	});

	test('a terminated reason from the SDK is 130', async () => {
		assert.strictEqual(await createWasmerProcess(fakeWasmer({ reason: 'terminated', exitCode: 137 }), base).run(), 130);
	});

	test('input and end-of-file written before the run reach the program once it starts', async () => {
		const seen: { stdinClosed?: boolean } = {};
		const written: Uint8Array[] = [];
		const p = createWasmerProcess(fakeWasmer({ written }, new Map(), seen), base);
		await p.stdin.write('one\n');
		await p.stdin.end();
		await p.run();
		assert.deepStrictEqual(written.map(w => decoder.decode(w)), ['one\n']);
		assert.strictEqual(seen.stdinClosed, true);
	});

	test('the workspace is copied in, changes are copied back after the run, and conflicts are noted', async () => {
		const hostFiles = new Map<string, Uint8Array>([['in.txt', new TextEncoder().encode('input')], ['mine.txt', new TextEncoder().encode('v1')]]);
		const host: FileTree = {
			async readDir(path) { const prefix = path ? `${path}/` : ''; const seen = new Map<string, boolean>(); for (const f of hostFiles.keys()) { if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); const i = rest.indexOf('/'); seen.set(i < 0 ? rest : rest.slice(0, i), i >= 0); } } return [...seen].map(([name, isDir]) => ({ name, isDir })); },
			async readFile(path) { return hostFiles.get(path)!; },
			async writeFile(path, data) { hostFiles.set(path, data); },
			async remove(path) { hostFiles.delete(path); },
			async mkdir() { /* implied */ },
		};
		const sandboxFiles = new Map<string, Uint8Array>();
		const notes: string[] = [];
		const script: Script = {
			onWait: async () => {
				assert.strictEqual(decoder.decode(sandboxFiles.get('/workspace/in.txt')), 'input');
				sandboxFiles.set('/workspace/out.txt', new TextEncoder().encode('result'));
				sandboxFiles.set('/workspace/mine.txt', new TextEncoder().encode('program'));
				hostFiles.set('mine.txt', new TextEncoder().encode('user'));
			},
		};
		await createWasmerProcess(fakeWasmer(script, sandboxFiles), { ...base, workspace: { tree: host, sync: { skip: skipDefaultFolders } }, onNote: n => notes.push(n) }).run();
		assert.strictEqual(decoder.decode(hostFiles.get('out.txt')), 'result');
		assert.strictEqual(decoder.decode(hostFiles.get('mine.txt')), 'user');
		assert.match(notes.join('\n'), /mine\.txt.*edited in the editor/);
	});

	test('files are still copied back after a trap', async () => {
		const hostFiles = new Map<string, Uint8Array>();
		const host: FileTree = { readDir: async () => [], readFile: async p => hostFiles.get(p)!, writeFile: async (p, d) => { hostFiles.set(p, d); }, remove: async () => undefined, mkdir: async () => undefined };
		const sandboxFiles = new Map<string, Uint8Array>();
		const script: Script = { onWait: async () => { sandboxFiles.set('/workspace/partial.txt', new TextEncoder().encode('x')); }, throws: new Error('RuntimeError: unreachable') };
		const outcome = await createWasmerProcess(fakeWasmer(script, sandboxFiles), { ...base, workspace: { tree: host, sync: { skip: skipDefaultFolders } } }).runToOutcome();
		assert.strictEqual(outcome.kind, 'trap');
		assert.ok(hostFiles.has('partial.txt'));
	});
});

// Set VSCWCLANG_WASMER_SDK to a folder holding node_modules/@wasmer/sdk (npm install @wasmer/sdk there) to run these against the real SDK.
const sdkDir = process.env.VSCWCLANG_WASMER_SDK;
const FIXTURES = join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'host');
(sdkDir && existsSync(join(sdkDir, 'node_modules', '@wasmer', 'sdk')) ? suite : suite.skip)('wasmerProcess (real @wasmer/sdk, host fixtures)', function () {
	this.timeout(120000);
	let wasmer: WasmerLike & { close(): Promise<void> };
	suiteSetup(async () => {
		const sdk = await import(pathToFileURL(join(sdkDir!, 'node_modules', '@wasmer', 'sdk', 'dist', 'node.js')).href) as { Wasmer: { create(o: object): Promise<WasmerLike & { close(): Promise<void> }> } };
		wasmer = await sdk.Wasmer.create({ cache: 'memory' });
	});
	suiteTeardown(async () => { await wasmer?.close(); });

	async function run(fixture: string, args: string[] = [], stdin?: string) {
		const p = createWasmerProcess(wasmer, { name: fixture, bytes: readFileSync(join(FIXTURES, `${fixture}.wasm`)), args, env: { FOO: 'bar' }, cwd: '/workspace' });
		let out = '', err = '';
		p.stdout.onData(d => { out += decoder.decode(d); });
		p.stderr.onData(d => { err += decoder.decode(d); });
		if (stdin !== undefined) { await p.stdin.write(stdin); await p.stdin.end(); }
		const outcome = await p.runToOutcome();
		return { outcome, out, err };
	}

	test('hello: arguments, environment, stderr and exit code', async () => {
		const r = await run('hello', ['exit7', 'x']);
		assert.deepStrictEqual(r.outcome, { kind: 'exit', code: 7 });
		assert.strictEqual(r.out, 'hello exit7 x\nFOO=bar\n');
		assert.strictEqual(r.err, 'to-stderr\n');
	});

	test('echo: piped stdin lines reach the program', async () => {
		const r = await run('echo', [], 'line one\nline two\n');
		assert.deepStrictEqual(r.outcome, { kind: 'exit', code: 0 });
		assert.match(r.out, /got: line one/);
		assert.match(r.out, /got: line two/);
	});

	test('threads: a wasi-threads module runs', async () => {
		const r = await run('threads');
		assert.deepStrictEqual(r.outcome, { kind: 'exit', code: 0 });
		assert.match(r.out, /counter = 4000/);
	});

	test('trap: out-of-bounds, divide by zero and unreachable are trap outcomes with the engine message', async () => {
		assert.deepStrictEqual((await run('trap', ['oob'])).outcome, { kind: 'trap', message: 'memory access out of bounds' });
		assert.deepStrictEqual((await run('trap', ['div'])).outcome, { kind: 'trap', message: 'divide by zero' });
		assert.deepStrictEqual((await run('trap', ['trap'])).outcome, { kind: 'trap', message: 'unreachable' });
	});

	test('buffered: stdout is a terminal, so output printed before a read is delivered at once', async () => {
		const r = await run('buffered', [], 'go\n');
		assert.match(r.out, /isatty=1,1,1/);
	});

	test('fileio: the workspace is copied in, relative paths resolve there, and written files come back', async () => {
		const hostFiles = new Map<string, Uint8Array>();
		const host: FileTree = { readDir: async () => [], readFile: async p => hostFiles.get(p)!, writeFile: async (p, d) => { hostFiles.set(p, d); }, remove: async p => { hostFiles.delete(p); }, mkdir: async () => undefined };
		const p = createWasmerProcess(wasmer, { name: 'fileio', bytes: readFileSync(join(FIXTURES, 'fileio.wasm')), args: [], env: {}, cwd: '/workspace', workspace: { tree: host, sync: { skip: skipDefaultFolders } } });
		let out = '';
		p.stdout.onData(d => { out += decoder.decode(d); });
		assert.deepStrictEqual(await p.runToOutcome(), { kind: 'exit', code: 0 });
		assert.match(out, /read 29 bytes/);
		assert.strictEqual(decoder.decode(hostFiles.get('out.txt')), 'line one\nline two\nline three\n');
		assert.ok(![...hostFiles.keys()].some(k => k.startsWith('sub')), 'sub/ was created and removed by the program, so nothing of it comes back');
		assert.match(out, /tmp: writable/);
	});
});
