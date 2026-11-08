import * as assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { artifactBin, artifactPath, artifactResource } from '../artifacts';
import { pathToFileURL } from 'url';

const CLANG_THREADS = artifactBin('clang.wasm');
type RunWasi = (module: WebAssembly.Module, args: string[], preopens: Record<string, string>, bytes?: Uint8Array) => Promise<{ code: number; stderr: string }>;

suite('scripts/clang-wasi.mjs with the threaded clang.wasm', function () {
	this.timeout(120_000);
	let dir: string;
	setup(() => { dir = mkdtempSync(join(tmpdir(), 'vscwclang-threads-')); });
	teardown(() => rmSync(dir, { recursive: true, force: true }));

	test('compiles a std::thread program to an object (shared memory + thread-spawn are supplied)', async function () {
		if (!existsSync(CLANG_THREADS) || !existsSync(artifactPath('sysroot'))) { return this.skip(); }
		// Not a static import: the module re-launches itself as a Worker, so esbuild must not bundle it.
		const { runWasi } = await import(pathToFileURL(resolve('scripts/clang-wasi.mjs')).href) as { runWasi: RunWasi };
		mkdirSync(join(dir, 'work'));
		writeFileSync(join(dir, 'work', 't.cpp'), '#include <thread>\nint main() { int x = 0; std::thread t([&] { x = 1; }); t.join(); return x - 1; }\n');
		const bytes = readFileSync(CLANG_THREADS);
		const flags = ['--target=wasm32-unknown-wasip1-threads', '--sysroot=/sysroot', '-resource-dir=/resource', '-isystem/sysroot/include/wasm32-wasip1-threads/eh/c++/v1', '-isystem/sysroot/include/c++/v1', '-fwasm-exceptions', '-pthread', '-fintegrated-cc1'];
		const result = await runWasi(await WebAssembly.compile(bytes), ['clang++', ...flags, '-c', '/work/t.cpp', '-o', '/work/t.o'], { '/sysroot': artifactPath('sysroot'), '/resource': artifactResource(), '/work': join(dir, 'work') }, bytes);
		assert.strictEqual(result.code, 0, result.stderr);
		assert.ok(existsSync(join(dir, 'work', 't.o')));
	});

	test('threaded clangd --check runs its worker threads and exits', async function () {
		const clangd = artifactBin('clangd.wasm');
		if (!existsSync(clangd) || !existsSync(artifactPath('sysroot'))) { return this.skip(); }
		const { runWasi } = await import(pathToFileURL(resolve('scripts/clang-wasi.mjs')).href) as { runWasi: RunWasi };
		mkdirSync(join(dir, 'work'));
		writeFileSync(join(dir, 'work', 'a.c'), 'int add(int a, int b) { return a + b; }\n');
		const bytes = readFileSync(clangd);
		const result = await runWasi(await WebAssembly.compile(bytes), ['clangd', '--check=/work/a.c', '-check-locations=false', '-background-index=false', '-resource-dir=/resource', '-log=verbose'], { '/sysroot': artifactPath('sysroot'), '/resource': artifactResource(), '/work': join(dir, 'work') }, bytes);
		assert.strictEqual(result.code, 0, result.stderr);
		assert.match(result.stderr, /Built preamble/);
	});

	test('without -fintegrated-cc1 the threaded driver says it needs a spawn hook', async function () {
		if (!existsSync(CLANG_THREADS) || !existsSync(artifactPath('sysroot'))) { return this.skip(); }
		const { runWasi } = await import(pathToFileURL(resolve('scripts/clang-wasi.mjs')).href) as { runWasi: RunWasi };
		mkdirSync(join(dir, 'work'));
		writeFileSync(join(dir, 'work', 't.cpp'), 'int main() {}\n');
		const bytes = readFileSync(CLANG_THREADS);
		const result = await runWasi(await WebAssembly.compile(bytes), ['clang++', '--target=wasm32-unknown-wasip1-threads', '--sysroot=/sysroot', '-resource-dir=/resource', '-c', '/work/t.cpp', '-o', '/work/t.o'], { '/sysroot': artifactPath('sysroot'), '/resource': artifactResource(), '/work': join(dir, 'work') }, bytes);
		assert.notStrictEqual(result.code, 0);
		assert.match(result.stderr, /spawn hook/);
	});
});
