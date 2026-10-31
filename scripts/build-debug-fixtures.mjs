// Rebuilds the debug-stub test fixtures (progstub.wasm, chattystub.wasm, loopstub.wasm, threadsstub.wasm, spinstub.wasm, locals.wasm) from
// src/web/debug/debugStub.c with the fork's own clang.wasm and lld.wasm under node:wasi, so they track the stub. Run
// after changing debugStub.c:
//   node scripts/build-debug-fixtures.mjs --release <llvm-project>/release/<tag> [--llvm <llvm-project>]
// --release is the output of llvm-project/wasi-tests/package_release.mjs (sysroot/, resource/, compile-flags.json); the
// tools come from the --llvm checkout (default ../../llvm-project relative to this repo): build-single-threaded/bin for
// plain fixtures, build/bin (the wasi-threads build) for threads.c, which targets wasm32-wasip1-threads.
import { WASI } from 'node:wasi';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runWasi } from './clang-wasi.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const release = option('--release');
if (!release) { throw new Error('usage: node scripts/build-debug-fixtures.mjs --release <packageReleaseDir> [--llvm <llvm-project>]'); }
const llvm = resolve(option('--llvm', join(root, '..', '..', 'llvm-project')));
const fixtures = join(root, 'src', 'web', 'test', 'fixtures', 'debug');
const stubSource = join(root, 'src', 'web', 'debug');
const flags = JSON.parse(readFileSync(join(release, 'compile-flags.json'), 'utf8'));
// Releases packaged before debugCoverage existed lack the key, but the --llvm tools always have these options.
const debugCoverage = flags.debugCoverage ?? ['-mllvm', '-sanitizer-coverage-stmt', '-mllvm', '-sanitizer-coverage-spill-debug-vars'];
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
// package_release.mjs nests the resource dir (resource/lib/clang/<version>); the toolchain mounts that version folder as /resource.
const nested = join(release, 'resource', 'lib', 'clang');
const resourceDir = existsSync(nested) ? join(nested, readdirSync(nested)[0]) : join(release, 'resource');
const preopens = work => ({ '/sysroot': join(release, 'sysroot'), '/resource': resourceDir, '/src': fixtures, '/stub': stubSource, '/work': work });

const tool = (threaded, name) => join(llvm, threaded ? 'build' : 'build-single-threaded', 'bin', name);
for (const needed of [tool(false, 'clang.wasm'), tool(false, 'lld.wasm'), tool(true, 'clang.wasm'), tool(true, 'lld.wasm'), join(release, 'sysroot'), resourceDir]) {
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

const instrument = ['-O0', '-g', '-fsanitize-coverage=trace-pc-guard,no-prune', ...debugCoverage, '-fdebug-prefix-map=/src/=', '-fdebug-prefix-map=/work='];
const work = mkdtempSync(join(tmpdir(), 'vscw-fixtures-'));
try {
	for (const [slice, threaded, names] of [['wasm32-wasip1', false, ['prog', 'chatty', 'loop', 'stepcall']], ['wasm32-wasip1-threads', true, ['threads', 'spin', 'stepcallmt']]]) {
		const compile = flags.compile[slice].map(sub);
		const link = flags.link[slice].map(sub);
		// The threaded driver spawns cc1 as a subprocess unless told not to (see notes.md 2026-10-29).
		const driver = threaded ? ['-fintegrated-cc1'] : [];
		await run(threaded, 'clang.wasm', ['clang', ...compile, ...driver, '-O2', '-c', '/stub/debugStub.c', '-o', `/work/debugStub-${slice}.o`], work);
		for (const name of names) {
			await run(threaded, 'clang.wasm', ['clang', ...compile, ...driver, ...instrument, '-c', `/src/${name}.c`, '-o', `/work/${name}.o`], work);
			await run(threaded, 'lld.wasm', ['wasm-ld', link[0], `/work/${name}.o`, `/work/debugStub-${slice}.o`, '--export=__sanitizer_cov_trace_pc_guard', ...link.slice(1), '-o', `/work/${name}stub.wasm`], work);
			copyFileSync(join(work, `${name}stub.wasm`), join(fixtures, `${name}stub.wasm`));
			console.log(`rebuilt ${name}stub.wasm (${slice})`);
		}
	}
	// locals.wasm has no stub: reactorHost tests give it a JS hook (an imported __sanitizer_cov_trace_pc_guard).
	const compile = flags.compile['wasm32-wasip1'].map(sub);
	const link = flags.link['wasm32-wasip1'].map(sub);
	await run(false, 'clang.wasm', ['clang', ...compile, ...instrument, '-c', '/src/locals.c', '-o', '/work/locals.o'], work);
	await run(false, 'lld.wasm', ['wasm-ld', link[0], '/work/locals.o', '--export=__stack_pointer', '--allow-undefined', ...link.slice(1), '-o', '/work/locals.wasm'], work);
	copyFileSync(join(work, 'locals.wasm'), join(fixtures, 'locals.wasm'));
	console.log('rebuilt locals.wasm');
} finally {
	rmSync(work, { recursive: true, force: true });
}
