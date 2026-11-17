// Builds the stripped, zipped, chunked, hashed toolchain layout the extension downloads (design_distribution.md "Distribution")
// straight from the llvm-project build trees.
//
// usage: node scripts/make-toolchain-dist.mjs --release <packageReleaseDir> --mtdist <outDir> [--llvm <llvm-project>]
//          [--tag <tag>] [--chunk-mib 16] [--pin] [--if-missing] [--no-pch]
//   --release     output of llvm-project/wasi-tests/package_release.mjs (supplies sysroot/, resource/, compile-flags.json)
//   --llvm        llvm-project checkout (default ../../llvm-project relative to this repo), or a staging folder with the same
//                 bin paths. The shipped tools are the PGO builds (llvm-project/pgo/*-variant.bat), not the trees' own bat output,
//                 so a release stages them into such a folder (see documents/notes.md "v24.0.11 release method").
//   --mtdist      the only layout: build/bin/{clang,lld}.wasm, build-clangd-threads/bin/clangd.wasm,
//                 build-lldb/bin/lldb-wasm-reactor.wasm, build/bin/llvm-ar.wasm (all import shared memory; the extension host runs their
//                 threads in Workers, see workerThreads.ts)
//   --pin         write the manifest SHA-256 and the jsDelivr baseUrl (@<tag>/mtdist) into src/web/toolchain/toolchainPin.ts
//   --if-missing  skip the layout if <outDir>/manifest.json already exists
//   --no-pch      skip the libc++ precompiled headers (a PCH per -std and -O level, each built by the layout's own clang.wasm, ~6 s each)
// A payload larger than --chunk-mib is split into <name>.000, .001, ...; at most that size is served per file.
// Zips embed timestamps, so every run changes every chunk hash even for identical content; keep the old zips for unchanged files.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, mkdtempSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { strip } from './strip-wasm.mjs';
import { runWasi } from './clang-wasi.mjs';
import { DEFAULT_COMPILE_FLAGS } from '../src/web/toolchain/defaultFlags.ts';
import { PCH_HEADER_GUEST_PATH, PCH_HEADER_SOURCE } from '../src/web/toolchain/pch.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const release = option('--release');
const llvm = resolve(option('--llvm', join(import.meta.dirname, '..', '..', '..', 'llvm-project')));
if (args.includes('--dist')) {
	throw new Error('--dist (the single-threaded layout) was removed: the extension only runs the multithreaded layout. Did you mean --mtdist <outDir>?');
}
const layouts = [
	// PCHs come from this layout's own (threaded) clang.wasm, one set per slice, since a PCH must come from the clang that uses it.
	// -fintegrated-cc1: the threaded driver spawns cc1 as a subprocess otherwise, which clang-wasi.mjs does not provide.
	{ outDir: option('--mtdist'), name: 'mtdist', pchSlices: ['wasm32-wasip1', 'wasm32-wasip1-threads'], driverFlags: ['-fintegrated-cc1'], binaries: [
		['clang.wasm', 'build/bin/clang.wasm'],
		['lld.wasm', 'build/bin/lld.wasm'],
		['clangd.wasm', 'build-clangd-threads/bin/clangd.wasm'],
		['lldb-wasm-reactor.wasm', 'build-lldb/bin/lldb-wasm-reactor.wasm'],
		['llvm-ar.wasm', 'build/bin/llvm-ar.wasm'],
	] },
].filter((l) => l.outDir);
if (!release || layouts.length === 0) {
	console.error('usage: node scripts/make-toolchain-dist.mjs --release <packageReleaseDir> --mtdist <outDir> [--llvm <llvm-project>] [--tag <tag>] [--chunk-mib 16] [--pin] [--if-missing] [--no-pch]\n' +
		'(--release is the output of llvm-project/wasi-tests/package_release.mjs)');
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
// package_release.mjs nests the resource dir as resource/lib/clang/<version>; the toolchain mounts that version folder as /resource.
const nestedResource = join(release, 'resource', 'lib', 'clang');
walk(existsSync(nestedResource) ? join(nestedResource, readdirSync(nestedResource)[0]) : join(release, 'resource'), 'resource', sysrootEntries);
// A PCH records its source header, and clang cannot load the PCH without it.
sysrootEntries[`sysroot${PCH_HEADER_GUEST_PATH.slice('/sysroot'.length)}`] = [Buffer.from(PCH_HEADER_SOURCE), { level: 9 }];
const sysrootZip = Buffer.from(zipSync(sysrootEntries));
const releaseFlags = JSON.parse(readFileSync(join(release, 'compile-flags.json'), 'utf8'));

const stripped = new Map();
function strippedBinary(rel) {
	if (!stripped.has(rel)) {
		const path = join(llvm, rel);
		if (!existsSync(path)) { throw new Error(`missing ${path}; did you mean to run the matching build .bat in llvm-project first?`); }
		stripped.set(rel, strip(readFileSync(path)));
	}
	return stripped.get(rel);
}

// One PCH per -std and -O level (clang rejects a PCH used at another one); the extension picks by the user's flags (pch.ts).
const PCH_DEFAULT_STD = 'gnu++17';
const PCH_STDS = [PCH_DEFAULT_STD, 'c++17', 'gnu++20', 'c++20'];
const PCH_OPTIMIZATIONS = ['0', '2'];

/**
 * Builds the PCHs with `clangBytes` against a copy of the shipped sysroot whose files have mtime 0, which is what the
 * extension's in-memory file system reports; clang checks input mtimes when it loads a PCH. The content-hash flag is
 * the fallback if the two ever differ. Each PCH is then used once, with no -std for the default one as the extension does.
 */
async function buildPchs(clangBytes, layout, slice, driverFlags) {
	const root = mkdtempSync(join(tmpdir(), 'vscwclang-pch-'));
	try {
		for (const [name, [content]] of Object.entries(sysrootEntries)) {
			const path = join(root, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			utimesSync(path, 0, 0);
		}
		mkdirSync(join(root, 'pch'));
		mkdirSync(join(root, 'work'));
		writeFileSync(join(root, 'work', 'smoke.cpp'), '#include <vector>\n#include <string>\nint main() { std::vector<std::string> v; return (int)v.size(); }\n');
		const preopens = { '/sysroot': join(root, 'sysroot'), '/resource': join(root, 'resource'), '/pch': join(root, 'pch'), '/work': join(root, 'work') };
		const module = await WebAssembly.compile(clangBytes);
		const sliceSuffix = slice === 'wasm32-wasip1' ? '' : slice.slice('wasm32-wasip1'.length);
		const sub = (f) => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
		const base = ['clang++', ...releaseFlags.compile[slice].map(sub), ...DEFAULT_COMPILE_FLAGS, ...driverFlags, '-fno-color-diagnostics'];
		const variants = [];
		for (const std of PCH_STDS) {
			for (const optimization of PCH_OPTIMIZATIONS) {
				const file = `pch-${std.replace(/\+/g, 'p')}${optimization === '0' ? '' : `-O${optimization}`}${sliceSuffix}.pch`;
				const opt = optimization === '0' ? [] : [`-O${optimization}`];
				const build = await runWasi(module, [...base, `-std=${std}`, ...opt, '-Xclang', '-fno-pch-timestamp', '-Xclang', '-fvalidate-ast-input-files-content', '-x', 'c++-header', PCH_HEADER_GUEST_PATH, '-o', `/pch/${file}`], preopens, clangBytes);
				if (build.code !== 0) { throw new Error(`[${layout}] building ${file} failed (exit ${build.code}):\n${build.stderr}`); }
				// Without -std for the default variant: the extension passes none, so this proves clang's default is what the PCH was built for.
				const smoke = await runWasi(module, [...base, ...(std === PCH_DEFAULT_STD ? [] : [`-std=${std}`]), ...opt, '-include-pch', `/pch/${file}`, '-c', '/work/smoke.cpp', '-o', '/work/smoke.o'], preopens, clangBytes);
				if (smoke.code !== 0) { throw new Error(`[${layout}] ${file} was built but clang rejects it (exit ${smoke.code}):\n${smoke.stderr}`); }
				variants.push({ file, std, optimization, content: readFileSync(join(root, 'pch', file)) });
				console.log(`[${layout}] ${file}: ${variants.at(-1).content.length} bytes, built in ${Math.round(build.ms)} ms, smoke compile ${Math.round(smoke.ms)} ms`);
			}
		}
		return variants;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

for (const { outDir, name: layout, binaries, pchSlices, driverFlags } of layouts) {
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
	const flagsJson = structuredClone(releaseFlags);
	if (!flag('--no-pch')) {
		flagsJson.pch = {};
		for (const slice of pchSlices) {
			const variants = await buildPchs(strippedBinary(binaries.find(([n]) => n === 'clang.wasm')[1]), layout, slice, driverFlags);
			for (const v of variants) { add(v.file, v.content, 'zip', zipSync({ [v.file]: [v.content, { level: 9 }] }), v.file.replace(/\.pch$/, '.zip')); }
			flagsJson.pch[slice] = { defaultStd: PCH_DEFAULT_STD, variants: variants.map(({ file, std, optimization }) => ({ file, std, optimization })) };
		}
	}
	const flags = Buffer.from(JSON.stringify(flagsJson, null, 2));
	add('compile-flags.json', flags, 'raw', flags, 'compile-flags.json');
	const manifestText = JSON.stringify({ format: 1, tag, files }, null, 2);
	writeFileSync(join(outDir, 'manifest.json'), manifestText);
	const manifestSha = sha256(Buffer.from(manifestText));
	console.log(`[${layout}] manifest.json (tag ${tag}) sha256 ${manifestSha}`);

	if (flag('--pin') && layout === 'mtdist') {
		const pinFile = 'src/web/toolchain/toolchainPin.ts';
		const text = readFileSync(pinFile, 'utf8');
		const updated = text
			.replace(/manifestSha256: '[0-9a-f]*'/, `manifestSha256: '${manifestSha}'`)
			.replace(/(llvm-artifacts)@[^/']+\/\w+'/, `$1@${tag}/${layout}'`);
		if (updated === text && !text.includes(manifestSha)) { throw new Error(`${pinFile}: no manifestSha256 field to update`); }
		writeFileSync(pinFile, updated);
		console.log(`pinned in ${pinFile}`);
	}
}
