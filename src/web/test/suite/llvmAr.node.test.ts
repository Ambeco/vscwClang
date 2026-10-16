import * as assert from 'assert';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WASI } from 'wasi';

const BIN = join(process.cwd(), 'llvm-artifacts', 'bin');
const AR = join(BIN, 'llvm-ar.wasm');
const CLANG = join(BIN, 'clang.wasm');
const LLD = join(BIN, 'lld.wasm');

// WASI has no cwd, so every path is absolute under the single /work preopen.
suite('llvm-ar.wasm (node:wasi)', function () {
	this.timeout(120_000);
	let work: string;
	const modules = new Map<string, WebAssembly.Module>();

	function run(wasmFile: string, argv0: string, args: string[]): { code: number; out: string; err: string } {
		let module = modules.get(wasmFile);
		if (!module) { module = new WebAssembly.Module(readFileSync(wasmFile)); modules.set(wasmFile, module); }
		const outPath = join(work, '.stdout'), errPath = join(work, '.stderr');
		const outFd = openSync(outPath, 'w'), errFd = openSync(errPath, 'w');
		try {
			const wasi = new WASI({ version: 'preview1', args: [argv0, ...args], preopens: { '/work': work }, returnOnExit: true, stdout: outFd, stderr: errFd });
			const code = wasi.start(new WebAssembly.Instance(module, wasi.getImportObject() as WebAssembly.Imports)) as number;
			return { code, out: readFileSync(outPath, 'utf8'), err: readFileSync(errPath, 'utf8') };
		} finally { closeSync(outFd); closeSync(errFd); }
	}
	const ar = (...args: string[]) => run(AR, 'llvm-ar', args);
	const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);

	suiteSetup(function () {
		if (!existsSync(AR)) { this.skip(); } // llvm-ar.wasm is a local artifact (llvm-artifacts is gitignored)
	});
	setup(() => { work = mkdtempSync(join(tmpdir(), 'vscwclang-ar-')); });
	teardown(() => { rmSync(work, { recursive: true, force: true }); });

	test('rc creates an archive, t lists members in order, p prints one', () => {
		writeFileSync(join(work, 'a.txt'), 'alpha');
		writeFileSync(join(work, 'b.txt'), 'bravo');
		const made = ar('rc', '/work/lib.a', '/work/a.txt', '/work/b.txt');
		assert.strictEqual(made.code, 0, made.err);
		assert.deepStrictEqual(lines(ar('t', '/work/lib.a').out), ['a.txt', 'b.txt']);
		assert.strictEqual(ar('p', '/work/lib.a', 'b.txt').out, 'bravo');
	});

	test('x --output=<dir> extracts every member, or only the named ones', () => {
		writeFileSync(join(work, 'a.txt'), 'alpha');
		writeFileSync(join(work, 'b.txt'), 'bravo');
		ar('rc', '/work/lib.a', '/work/a.txt', '/work/b.txt');
		mkdirSync(join(work, 'all')); mkdirSync(join(work, 'one'));
		assert.strictEqual(ar('x', '--output=/work/all', '/work/lib.a').code, 0);
		assert.deepStrictEqual(readdirSync(join(work, 'all')).sort(), ['a.txt', 'b.txt']);
		assert.strictEqual(readFileSync(join(work, 'all', 'a.txt'), 'utf8'), 'alpha');
		assert.strictEqual(ar('x', '--output=/work/one', '/work/lib.a', 'b.txt').code, 0);
		assert.deepStrictEqual(readdirSync(join(work, 'one')), ['b.txt']);
	});

	test('r replaces a member, d deletes one, q appends', () => {
		writeFileSync(join(work, 'a.txt'), 'one');
		writeFileSync(join(work, 'b.txt'), 'two');
		ar('rc', '/work/lib.a', '/work/a.txt', '/work/b.txt');
		writeFileSync(join(work, 'a.txt'), 'ONE');
		assert.strictEqual(ar('r', '/work/lib.a', '/work/a.txt').code, 0);
		assert.strictEqual(ar('p', '/work/lib.a', 'a.txt').out, 'ONE');
		assert.strictEqual(ar('d', '/work/lib.a', 'b.txt').code, 0);
		assert.deepStrictEqual(lines(ar('t', '/work/lib.a').out), ['a.txt']);
		writeFileSync(join(work, 'c.txt'), 'three');
		assert.strictEqual(ar('q', '/work/lib.a', '/work/c.txt').code, 0);
		assert.deepStrictEqual(lines(ar('t', '/work/lib.a').out), ['a.txt', 'c.txt']);
	});

	test('failures exit non-zero with a message: missing archive, missing member, unknown operation', () => {
		const noArchive = ar('t', '/work/nope.a');
		assert.notStrictEqual(noArchive.code, 0);
		assert.ok(noArchive.err.length > 0, 'expected a message on stderr');
		writeFileSync(join(work, 'a.txt'), 'x');
		ar('rc', '/work/lib.a', '/work/a.txt');
		const missing = ar('p', '/work/lib.a', 'missing.txt');
		assert.strictEqual(missing.code, 1);
		assert.match(missing.err, /'missing\.txt' was not found/);
		const bad = ar('Z', '/work/lib.a');
		assert.strictEqual(bad.code, 1);
		assert.match(bad.err, /unknown option Z/);
	});

	suite('with real objects (needs clang.wasm and lld.wasm)', () => {
		suiteSetup(function () { if (!existsSync(CLANG) || !existsSync(LLD)) { this.skip(); } });

		function compile(name: string, source: string) {
			writeFileSync(join(work, `${name}.c`), source);
			const r = run(CLANG, 'clang', ['--target=wasm32-wasip1', '-ffreestanding', '-nostdinc', '-O1', '-c', `/work/${name}.c`, '-o', `/work/${name}.o`]);
			assert.strictEqual(r.code, 0, r.err);
		}
		function linkAndCall(archive: string, exportName: string): number {
			const r = run(LLD, 'wasm-ld', ['--no-entry', `--export=${exportName}`, archive, '-o', '/work/out.wasm']);
			assert.strictEqual(r.code, 0, r.err);
			const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(work, 'out.wasm'))));
			return (instance.exports[exportName] as () => number)();
		}
		function makeObjects() {
			compile('one', 'int two(void);\nint one_plus_two(void) { return 1 + two(); }\n');
			compile('two', 'int two(void) { return 2; }\n');
			compile('unused', 'int never_pulled(void) { return 99; }\n');
		}

		test('rcs writes a symbol table, so wasm-ld pulls only the members it needs', () => {
			makeObjects();
			assert.strictEqual(ar('rcs', '/work/lib.a', '/work/one.o', '/work/two.o', '/work/unused.o').code, 0);
			assert.strictEqual(linkAndCall('/work/lib.a', 'one_plus_two'), 3);
		});

		test('llvm-ranlib (llvm-ar.wasm under another argv[0]) adds the symbol table to an rc archive', () => {
			makeObjects();
			assert.strictEqual(ar('rc', '/work/lib.a', '/work/one.o', '/work/two.o').code, 0);
			const r = run(AR, 'llvm-ranlib', ['/work/lib.a']);
			assert.strictEqual(r.code, 0, r.err);
			assert.strictEqual(linkAndCall('/work/lib.a', 'one_plus_two'), 3);
		});

		test('x then re-archive round-trips an object byte-for-byte', () => {
			makeObjects();
			ar('rc', '/work/lib.a', '/work/two.o');
			mkdirSync(join(work, 'x'));
			assert.strictEqual(ar('x', '--output=/work/x', '/work/lib.a').code, 0);
			assert.ok(readFileSync(join(work, 'x', 'two.o')).equals(readFileSync(join(work, 'two.o'))));
		});
	});
});
