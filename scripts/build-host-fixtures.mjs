// Rebuilds the V2 host test fixtures (src/web/test/fixtures/host/*.wasm) from the .c files beside them with the
// fork's own clang.wasm and lld.wasm under node:wasi. Run after editing a fixture:
//   node scripts/build-host-fixtures.mjs --release <llvm-project>/release/<tag> [--llvm <llvm-project>]
// --release is the output of llvm-project/wasi-tests/package_release.mjs (sysroot/, resource/, compile-flags.json); the
// tools come from the --llvm checkout (default ../../llvm-project relative to this repo): build-single-threaded/bin for
// plain fixtures, build/bin (the wasi-threads build) for fixtures named threads*.c, which target wasm32-wasip1-threads.
import { WASI } from 'node:wasi';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runWasi } from './clang-wasi.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const release = option('--release');
if (!release) { throw new Error('usage: node scripts/build-host-fixtures.mjs --release <packageReleaseDir> [--llvm <llvm-project>]'); }
const llvm = resolve(option('--llvm', join(root, '..', '..', 'llvm-project')));
const fixtures = join(root, 'src', 'web', 'test', 'fixtures', 'host');
const flags = JSON.parse(readFileSync(join(release, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
// package_release.mjs nests the resource dir (resource/lib/clang/<version>); the toolchain mounts that version folder as /resource.
const nested = join(release, 'resource', 'lib', 'clang');
const resourceDir = existsSync(nested) ? join(nested, readdirSync(nested)[0]) : join(release, 'resource');
const preopens = work => ({ '/sysroot': join(release, 'sysroot'), '/resource': resourceDir, '/src': fixtures, '/work': work });

const tool = (threaded, name) => join(llvm, threaded ? 'build' : 'build-single-threaded', 'bin', name);
for (const needed of [tool(false, 'clang.wasm'), tool(false, 'lld.wasm'), tool(true, 'clang.wasm'), tool(true, 'lld.wasm'), join(release, 'sysroot'), join(release, 'resource')]) {
	if (!existsSync(needed)) { throw new Error(`${needed} is missing; did you mean to build llvm-project (build-single-threaded.bat, build.bat) or pass --release/--llvm?`); }
}

async function run(threaded, wasmFile, toolArgs, work) {
	const bytes = readFileSync(tool(threaded, wasmFile));
	const module = await WebAssembly.compile(bytes);
	if (threaded) {
		const r = await runWasi(module, toolArgs, preopens(work), bytes);
		if (r.code !== 0) { throw new Error(`${wasmFile} ${toolArgs.join(' ')} exited with ${r.code}: ${r.stderr}`); }
		return;
	}
	const wasi = new WASI({ version: 'preview1', args: toolArgs, returnOnExit: true, preopens: preopens(work) });
	const code = wasi.start(await WebAssembly.instantiate(module, wasi.getImportObject()));
	if (code !== 0) { throw new Error(`${wasmFile} ${toolArgs.join(' ')} exited with ${code}`); }
}

const work = mkdtempSync(join(tmpdir(), 'vscw-host-fixtures-'));
try {
	for (const file of readdirSync(fixtures).filter(f => f.endsWith('.c'))) {
		const name = file.replace(/\.c$/, '');
		const threaded = name.startsWith('threads');
		const slice = threaded ? 'wasm32-wasip1-threads' : 'wasm32-wasip1';
		const compile = flags.compile[slice].map(sub);
		const link = flags.link[slice].map(sub);
		// The threaded driver spawns cc1 as a subprocess unless told not to (see notes.md 2026-10-29).
		await run(threaded, 'clang.wasm', ['clang', ...compile, ...(threaded ? ['-fintegrated-cc1'] : []), '-O0', '-c', `/src/${file}`, '-o', `/work/${name}.o`], work);
		await run(threaded, 'lld.wasm', ['wasm-ld', link[0], `/work/${name}.o`, ...link.slice(1), '-o', `/work/${name}.wasm`], work);
		copyFileSync(join(work, `${name}.wasm`), join(fixtures, `${name}.wasm`));
		console.log(`rebuilt ${name}.wasm (${slice})`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
