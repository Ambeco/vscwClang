import * as assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { artifactBin } from '../artifacts';

const BIN = artifactBin('');
const AR = join(BIN, 'llvm-ar.wasm');
const CLANG = join(BIN, 'clang.wasm');
const LLD = join(BIN, 'lld.wasm');

type RunWasi = (module: WebAssembly.Module, args: string[], preopens: Record<string, string>, bytes?: Uint8Array) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

// WASI has no cwd, so every path is absolute under the single /work preopen.
suite('llvm-ar.wasm (node:wasi, shared-memory build)', function () {
	this.timeout(120_000);
	let work: string;
	let runWasi: RunWasi;
	const modules = new Map<string, { module: WebAssembly.Module; bytes: Buffer }>();

	async function run(wasmFile: string, argv0: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
		let entry = modules.get(wasmFile);
		if (!entry) { const bytes = readFileSync(wasmFile); entry = { module: await WebAssembly.compile(bytes), bytes }; modules.set(wasmFile, entry); }
		const r = await runWasi(entry.module, [argv0, ...args], { '/work': work }, entry.bytes);
		return { code: r.code, out: r.stdout.toString('utf8'), err: r.stderr };
	}
	const ar = (...args: string[]) => run(AR, 'llvm-ar', args);
	const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);

	suiteSetup(async function () {
		if (!existsSync(AR)) { this.skip(); } // llvm-ar.wasm is a local artifact (llvm-artifacts is gitignored)
		// Not a static import: the module re-launches itself as a Worker, so esbuild must not bundle it.
		({ runWasi } = await import(pathToFileURL(resolve('scripts/clang-wasi.mjs')).href) as { runWasi: RunWasi });
	});
	setup(() => { work = mkdtempSync(join(tmpdir(), 'vscwclang-ar-')); });
	teardown(() => { rmSync(work, { recursive: true, force: true }); });

	test('rc creates an archive, t lists members in order, p prints one', async () => {
		writeFileSync(join(work, 'a.txt'), 'alpha');
		writeFileSync(join(work, 'b.txt'), 'bravo');
		const made = await ar('rc', '/work/lib.a', '/work/a.txt', '/work/b.txt');
		assert.strictEqual(made.code, 0, made.err);
		assert.deepStrictEqual(lines((await ar('t', '/work/lib.a')).out), ['a.txt', 'b.txt']);
		assert.strictEqual((await ar('p', '/work/lib.a', 'b.txt')).out, 'bravo');
	});

	test('x --output=<dir> extracts every member, or only the named ones', async () => {
		writeFileSync(join(work, 'a.txt'), 'alpha');
		writeFileSync(join(work, 'b.txt'), 'bravo');
		await ar('rc', '/work/lib.a', '/work/a.txt', '/work/b.txt');
		mkdirSync(join(work, 'all')); mkdirSync(join(work, 'one'));
		assert.strictEqual((await ar('x', '--output=/work/all', '/work/lib.a')).code, 0);
		assert.deepStrictEqual(readdirSync(join(work, 'all')).sort(), ['a.txt', 'b.txt']);
		assert.strictEqual(readFileSync(join(work, 'all', 'a.txt'), 'utf8'), 'alpha');
		assert.strictEqual((await ar('x', '--output=/work/one', '/work/lib.a', 'b.txt')).code, 0);
		assert.deepStrictEqual(readdirSync(join(work, 'one')), ['b.txt']);
	});

	test('r replaces a member, d deletes one, q appends', async () => {
		writeFileSync(join(work, 'a.txt'), 'one');
		writeFileSync(join(work, 'b.txt'), 'two');
		await ar('rc', '/work/lib.a', '/work/a.txt', '/work/b.txt');
		writeFileSync(join(work, 'a.txt'), 'ONE');
		assert.strictEqual((await ar('r', '/work/lib.a', '/work/a.txt')).code, 0);
		assert.strictEqual((await ar('p', '/work/lib.a', 'a.txt')).out, 'ONE');
		assert.strictEqual((await ar('d', '/work/lib.a', 'b.txt')).code, 0);
		assert.deepStrictEqual(lines((await ar('t', '/work/lib.a')).out), ['a.txt']);
		writeFileSync(join(work, 'c.txt'), 'three');
		assert.strictEqual((await ar('q', '/work/lib.a', '/work/c.txt')).code, 0);
		assert.deepStrictEqual(lines((await ar('t', '/work/lib.a')).out), ['a.txt', 'c.txt']);
	});

	test('failures exit non-zero with a message: missing archive, missing member, unknown operation', async () => {
		const noArchive = await ar('t', '/work/nope.a');
		assert.notStrictEqual(noArchive.code, 0);
		assert.ok(noArchive.err.length > 0, 'expected a message on stderr');
		writeFileSync(join(work, 'a.txt'), 'x');
		await ar('rc', '/work/lib.a', '/work/a.txt');
		const missing = await ar('p', '/work/lib.a', 'missing.txt');
		assert.strictEqual(missing.code, 1);
		assert.match(missing.err, /'missing\.txt' was not found/);
		const bad = await ar('Z', '/work/lib.a');
		assert.strictEqual(bad.code, 1);
		assert.match(bad.err, /unknown option Z/);
	});

	suite('with real objects (needs clang.wasm and lld.wasm)', () => {
		suiteSetup(function () { if (!existsSync(CLANG) || !existsSync(LLD)) { this.skip(); } });

		async function compile(name: string, source: string): Promise<void> {
			writeFileSync(join(work, `${name}.c`), source);
			// -fintegrated-cc1: the threaded driver would spawn cc1 as a subprocess, which clang-wasi.mjs does not provide.
			const r = await run(CLANG, 'clang', ['--target=wasm32-wasip1', '-fintegrated-cc1', '-ffreestanding', '-nostdinc', '-O1', '-c', `/work/${name}.c`, '-o', `/work/${name}.o`]);
			assert.strictEqual(r.code, 0, r.err);
		}
		async function linkAndCall(archive: string, exportName: string): Promise<number> {
			const r = await run(LLD, 'wasm-ld', ['--no-entry', `--export=${exportName}`, archive, '-o', '/work/out.wasm']);
			assert.strictEqual(r.code, 0, r.err);
			const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(work, 'out.wasm'))));
			return (instance.exports[exportName] as () => number)();
		}
		async function makeObjects(): Promise<void> {
			await compile('one', 'int two(void);\nint one_plus_two(void) { return 1 + two(); }\n');
			await compile('two', 'int two(void) { return 2; }\n');
			await compile('unused', 'int never_pulled(void) { return 99; }\n');
		}

		test('rcs writes a symbol table, so wasm-ld pulls only the members it needs', async () => {
			await makeObjects();
			assert.strictEqual((await ar('rcs', '/work/lib.a', '/work/one.o', '/work/two.o', '/work/unused.o')).code, 0);
			assert.strictEqual(await linkAndCall('/work/lib.a', 'one_plus_two'), 3);
		});

		test('llvm-ranlib (llvm-ar.wasm under another argv[0]) adds the symbol table to an rc archive', async () => {
			await makeObjects();
			assert.strictEqual((await ar('rc', '/work/lib.a', '/work/one.o', '/work/two.o')).code, 0);
			const r = await run(AR, 'llvm-ranlib', ['/work/lib.a']);
			assert.strictEqual(r.code, 0, r.err);
			assert.strictEqual(await linkAndCall('/work/lib.a', 'one_plus_two'), 3);
		});

		test('x then re-archive round-trips an object byte-for-byte', async () => {
			await makeObjects();
			await ar('rc', '/work/lib.a', '/work/two.o');
			mkdirSync(join(work, 'x'));
			assert.strictEqual((await ar('x', '--output=/work/x', '/work/lib.a')).code, 0);
			assert.ok(readFileSync(join(work, 'x', 'two.o')).equals(readFileSync(join(work, 'two.o'))));
		});
	});
});
