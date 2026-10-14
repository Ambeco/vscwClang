// Builds the stripped, zipped, chunked, hashed toolchain layout the extension downloads (design.md "Distribution")
// straight from the llvm-project build trees.
//
// usage: node scripts/make-toolchain-dist.mjs --release <packageReleaseDir> [--llvm <llvm-project>] [--dist <outDir>]
//          [--mtdist <outDir>] [--tag <tag>] [--chunk-mib 16] [--pin] [--if-missing]
//   --release     output of llvm-project/wasi-tests/package_release.mjs (supplies sysroot/, resource/, compile-flags.json)
//   --llvm        llvm-project checkout (default ../../llvm-project relative to this repo)
//   --dist        single-threaded layout: build-single-threaded/bin/{clang,lld,clangd,llvm-ar}.wasm,
//                 build-lldb-single-threaded/bin/lldb-wasm-reactor.wasm
//   --mtdist      multithreaded layout: build/bin/{clang,lld}.wasm, build-clangd-threads/bin/clangd.wasm,
//                 build-single-threaded/bin/llvm-ar.wasm (llvm-ranlib = llvm-ar.wasm run with argv[0] llvm-ranlib),
//                 build-lldb/bin/lldb-wasm-reactor.wasm (imports wasi.thread-spawn)
//   --pin         write the --dist manifest's SHA-256 into src/web/toolchain/toolchainPin.ts
//   --if-missing  skip a layout whose <outDir>/manifest.json already exists
// A payload larger than --chunk-mib is split into <name>.000, .001, ...; at most that size is served per file.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { strip } from './strip-wasm.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const release = option('--release');
const llvm = resolve(option('--llvm', join(import.meta.dirname, '..', '..', '..', 'llvm-project')));
const layouts = [
	{ outDir: option('--dist'), name: 'dist', binaries: [
		['clang.wasm', 'build-single-threaded/bin/clang.wasm'],
		['lld.wasm', 'build-single-threaded/bin/lld.wasm'],
		['clangd.wasm', 'build-single-threaded/bin/clangd.wasm'],
		['lldb-wasm-reactor.wasm', 'build-lldb-single-threaded/bin/lldb-wasm-reactor.wasm'],
		['llvm-ar.wasm', 'build-single-threaded/bin/llvm-ar.wasm'],
	] },
	{ outDir: option('--mtdist'), name: 'mtdist', binaries: [
		['clang.wasm', 'build/bin/clang.wasm'],
		['lld.wasm', 'build/bin/lld.wasm'],
		['clangd.wasm', 'build-clangd-threads/bin/clangd.wasm'],
		['lldb-wasm-reactor.wasm', 'build-lldb/bin/lldb-wasm-reactor.wasm'],
		['llvm-ar.wasm', 'build-single-threaded/bin/llvm-ar.wasm'], // no threaded variant: llvm-ar spawns no threads
	] },
].filter((l) => l.outDir);
if (!release || layouts.length === 0) {
	console.error('usage: node scripts/make-toolchain-dist.mjs --release <packageReleaseDir> [--llvm <llvm-project>] [--dist <outDir>] [--mtdist <outDir>] [--tag <tag>] [--chunk-mib 16] [--pin] [--if-missing]\n' +
		'(--release is the output of llvm-project/wasi-tests/package_release.mjs; pass at least one of --dist/--mtdist)');
	process.exit(1);
}
const chunkBytes = Number(option('--chunk-mib', '16')) * 1024 * 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const tag = option('--tag', readFileSync(join(release, 'MANIFEST'), 'utf8').match(/^tag (\S+)/m)?.[1] ?? 'dev');

// Not shipped: PIC shared objects (static wasm only; no dynamic linking). eh/ and llvm-lto/ stay so users can
// build with exceptions and -flto.
const UNSHIPPED = /\.so$/;
function walk(dir, prefix, entries) {
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) { walk(path, `${prefix}/${name}`, entries); }
		else if (!UNSHIPPED.test(`${prefix}/${name}`)) { entries[`${prefix}/${name}`] = [readFileSync(path), { level: 9 }]; }
	}
	return entries;
}
const sysrootEntries = {};
walk(join(release, 'sysroot'), 'sysroot', sysrootEntries);
walk(join(release, 'resource'), 'resource', sysrootEntries);
const sysrootZip = Buffer.from(zipSync(sysrootEntries));
const flags = readFileSync(join(release, 'compile-flags.json'));

const stripped = new Map();
function strippedBinary(rel) {
	if (!stripped.has(rel)) {
		const path = join(llvm, rel);
		if (!existsSync(path)) { throw new Error(`missing ${path}; did you mean to run the matching build .bat in llvm-project first?`); }
		stripped.set(rel, strip(readFileSync(path)));
	}
	return stripped.get(rel);
}

for (const { outDir, name: layout, binaries } of layouts) {
	if (flag('--if-missing') && existsSync(join(outDir, 'manifest.json'))) {
		console.log(`${outDir}/manifest.json exists; skipping ${layout}.`);
		continue;
	}
	mkdirSync(outDir, { recursive: true });
	for (const f of readdirSync(outDir)) { if (/\.zip(\.\d{3})?$|^manifest\.json$|^compile-flags\.json$/.test(f)) { rmSync(join(outDir, f)); } }
	const files = {};
	const add = (name, content, payloadKind, payload, payloadName) => {
		const chunks = [];
		if (payload.length <= chunkBytes) {
			writeFileSync(join(outDir, payloadName), payload);
			chunks.push({ name: payloadName, size: payload.length, sha256: sha256(payload) });
		} else {
			for (let i = 0, n = 0; i < payload.length; i += chunkBytes, n++) {
				const part = payload.subarray(i, i + chunkBytes);
				const chunkName = `${payloadName}.${String(n).padStart(3, '0')}`;
				writeFileSync(join(outDir, chunkName), part);
				chunks.push({ name: chunkName, size: part.length, sha256: sha256(part) });
			}
		}
		files[name] = { size: content.length, sha256: sha256(content), payloadKind, chunks };
		console.log(`[${layout}] ${name}: ${content.length} bytes -> ${payload.length} payload bytes in ${chunks.length} chunk(s)`);
	};
	for (const [wasmName, rel] of binaries) {
		const content = strippedBinary(rel);
		add(wasmName, content, 'zip', zipSync({ [wasmName]: [content, { level: 9 }] }), wasmName.replace(/\.wasm$/, '.zip'));
	}
	add('sysroot.zip', sysrootZip, 'raw', sysrootZip, 'sysroot.zip');
	add('compile-flags.json', flags, 'raw', flags, 'compile-flags.json');
	const manifestText = JSON.stringify({ format: 1, tag, files }, null, 2);
	writeFileSync(join(outDir, 'manifest.json'), manifestText);
	const manifestSha = sha256(Buffer.from(manifestText));
	console.log(`[${layout}] manifest.json (tag ${tag}) sha256 ${manifestSha}`);

	if (flag('--pin') && layout === 'dist') {
		const pinFile = 'src/web/toolchain/toolchainPin.ts';
		const text = readFileSync(pinFile, 'utf8');
		const updated = text.replace(/manifestSha256: '[0-9a-f]*'/, `manifestSha256: '${manifestSha}'`);
		if (updated === text && !text.includes(manifestSha)) { throw new Error(`${pinFile}: no manifestSha256 field to update`); }
		writeFileSync(pinFile, updated);
		console.log(`pinned in ${pinFile}`);
	}
}
