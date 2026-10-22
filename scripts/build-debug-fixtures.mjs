// Rebuilds the debug-stub test fixtures (progstub.wasm, chattystub.wasm) from src/web/debug/debugStub.c with the
// repo's own clang.wasm and lld.wasm under node:wasi, so they track the stub. Needs llvm-artifacts/ (bin, sysroot,
// resource, compile-flags.json). Run after changing debugStub.c: node scripts/build-debug-fixtures.mjs
import { WASI } from 'node:wasi';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'llvm-artifacts');
const fixtures = join(root, 'src', 'web', 'test', 'fixtures', 'debug');
const stubSource = join(root, 'src', 'web', 'debug');
const flags = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');

for (const needed of ['bin/clang.wasm', 'bin/lld.wasm', 'sysroot', 'resource']) {
	if (!existsSync(join(artifacts, needed))) { throw new Error(`${join(artifacts, needed)} is missing; did you mean to build or fetch the toolchain into llvm-artifacts/ first?`); }
}

async function run(wasmFile, args, work) {
	const wasi = new WASI({
		version: 'preview1', args, returnOnExit: true,
		preopens: { '/sysroot': join(artifacts, 'sysroot'), '/resource': join(artifacts, 'resource'), '/src': fixtures, '/stub': stubSource, '/work': work },
	});
	const instance = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(join(artifacts, 'bin', wasmFile))), wasi.getImportObject());
	const code = wasi.start(instance);
	if (code !== 0) { throw new Error(`${wasmFile} ${args.join(' ')} exited with ${code}`); }
}

const work = mkdtempSync(join(tmpdir(), 'vscw-fixtures-'));
try {
	const compile = flags.compile['wasm32-wasip1'].map(sub);
	await run('clang.wasm', ['clang', ...compile, '-O2', '-c', '/stub/debugStub.c', '-o', '/work/debugStub.o'], work);
	for (const name of ['prog', 'chatty']) {
		await run('clang.wasm', ['clang', ...compile, '-O0', '-g', '-fsanitize-coverage=trace-pc-guard', '-fdebug-prefix-map=/src/=', '-fdebug-prefix-map=/work=', '-c', `/src/${name}.c`, '-o', `/work/${name}.o`], work);
		const link = flags.link['wasm32-wasip1'].map(sub);
		await run('lld.wasm', ['wasm-ld', link[0], `/work/${name}.o`, '/work/debugStub.o', '--export=__sanitizer_cov_trace_pc_guard', ...link.slice(1), '-o', `/work/${name}stub.wasm`], work);
		copyFileSync(join(work, `${name}stub.wasm`), join(fixtures, `${name}stub.wasm`));
		console.log(`rebuilt ${name}stub.wasm`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
