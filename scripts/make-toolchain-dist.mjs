// Turns a llvm-project release tree into the chunked, hashed layout the extension downloads (design.md "Distribution").
// usage: node scripts/make-toolchain-dist.mjs <artifactsDir> <outDir> [--tag <tag>] [--chunk-mib 16] [--pin] [--if-missing]
//   --pin         write the manifest's SHA-256 into src/web/toolchain/toolchainPin.ts
//   --if-missing  do nothing when <outDir>/manifest.json already exists
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--tag', '--chunk-mib'].includes(args[i - 1])));
const [artifacts, outDir] = positional;
if (!artifacts || !outDir) {
	console.error('usage: node scripts/make-toolchain-dist.mjs <artifactsDir> <outDir> [--tag <tag>] [--chunk-mib 16] [--pin] [--if-missing]');
	process.exit(1);
}
if (flag('--if-missing') && existsSync(join(outDir, 'manifest.json'))) {
	console.log(`${outDir}/manifest.json exists; skipping.`);
	process.exit(0);
}
const chunkBytes = Number(option('--chunk-mib', '16')) * 1024 * 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
mkdirSync(outDir, { recursive: true });

const files = {};
function add(name, content, payloadKind, payload, payloadName) {
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
	console.log(`${name}: ${content.length} bytes -> ${payload.length} payload bytes in ${chunks.length} chunk(s)`);
}

for (const [wasmName, zipName] of [['clang.wasm', 'clang.zip'], ['lld.wasm', 'lld.zip']]) {
	const content = readFileSync(join(artifacts, 'bin', wasmName));
	add(wasmName, content, 'zip', zipSync({ [wasmName]: [content, { level: 9 }] }), zipName);
}
const clangdPath = join(artifacts, 'bin', 'clangd.wasm');
if (existsSync(clangdPath)) {
	const content = readFileSync(clangdPath);
	add('clangd.wasm', content, 'zip', zipSync({ 'clangd.wasm': [content, { level: 9 }] }), 'clangd.zip');
}
const sysroot = readFileSync(join(artifacts, 'zips', 'sysroot.zip'));
add('sysroot.zip', sysroot, 'raw', sysroot, 'sysroot.zip');
const flags = readFileSync(join(artifacts, 'compile-flags.json'));
add('compile-flags.json', flags, 'raw', flags, 'compile-flags.json');

const tag = option('--tag', readFileSync(join(artifacts, 'MANIFEST'), 'utf8').match(/^tag (\S+)/m)?.[1] ?? 'dev');
const manifestText = JSON.stringify({ format: 1, tag, files }, null, 2);
writeFileSync(join(outDir, 'manifest.json'), manifestText);
const manifestSha = sha256(Buffer.from(manifestText));
console.log(`manifest.json (tag ${tag}) sha256 ${manifestSha}`);

if (flag('--pin')) {
	const pinFile = 'src/web/toolchain/toolchainPin.ts';
	const text = readFileSync(pinFile, 'utf8');
	const updated = text.replace(/manifestSha256: '[0-9a-f]*'/, `manifestSha256: '${manifestSha}'`);
	if (updated === text && !text.includes(manifestSha)) { throw new Error(`${pinFile}: no manifestSha256 field to update`); }
	writeFileSync(pinFile, updated);
	console.log(`pinned in ${pinFile}`);
}
