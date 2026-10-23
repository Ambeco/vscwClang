// Rebuilds the V2 host test fixtures (src/web/test/fixtures/host/*.wasm) from the .c files beside them with the
// repo's own clang.wasm and lld.wasm under node:wasi. Needs llvm-artifacts/. Run after editing a fixture: node scripts/build-host-fixtures.mjs
import { WASI } from 'node:wasi';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'llvm-artifacts');
const fixtures = join(root, 'src', 'web', 'test', 'fixtures', 'host');
const flags = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');

for (const needed of ['bin/clang.wasm', 'bin/lld.wasm', 'sysroot', 'resource']) {
	if (!existsSync(join(artifacts, needed))) { throw new Error(`${join(artifacts, needed)} is missing; did you mean to build or fetch the toolchain into llvm-artifacts/ first?`); }
}

async function run(wasmFile, args, work) {
	const wasi = new WASI({
		version: 'preview1', args, returnOnExit: true,
		preopens: { '/sysroot': join(artifacts, 'sysroot'), '/resource': join(artifacts, 'resource'), '/src': fixtures, '/work': work },
	});
	const instance = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(join(artifacts, 'bin', wasmFile))), wasi.getImportObject());
	const code = wasi.start(instance);
	if (code !== 0) { throw new Error(`${wasmFile} ${args.join(' ')} exited with ${code}`); }
}

const work = mkdtempSync(join(tmpdir(), 'vscw-host-fixtures-'));
try {
	const compile = flags.compile['wasm32-wasip1'].map(sub);
	const link = flags.link['wasm32-wasip1'].map(sub);
	for (const file of readdirSync(fixtures).filter(f => f.endsWith('.c'))) {
		const name = file.replace(/\.c$/, '');
		await run('clang.wasm', ['clang', ...compile, '-O0', '-c', `/src/${file}`, '-o', `/work/${name}.o`], work);
		await run('lld.wasm', ['wasm-ld', link[0], `/work/${name}.o`, ...link.slice(1), '-o', `/work/${name}.wasm`], work);
		copyFileSync(join(work, `${name}.wasm`), join(fixtures, `${name}.wasm`));
		console.log(`rebuilt ${name}.wasm`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
