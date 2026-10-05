// Splits a wasm file into fixed-size chunks plus a JSON manifest: node scripts/split-wasm.mjs <in.wasm> <outDir> [chunkMiB=16]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

const [input, outDir, mib = '16'] = process.argv.slice(2);
if (!input || !outDir) {
	console.error('usage: node scripts/split-wasm.mjs <in.wasm> <outDir> [chunkMiB=16]');
	process.exit(1);
}
const size = Number(mib) * 1024 * 1024;
const data = readFileSync(input);
const name = basename(input);
mkdirSync(outDir, { recursive: true });
const chunks = [];
for (let i = 0, n = 0; i < data.length; i += size, n++) {
	const file = `${name}.${String(n).padStart(3, '0')}`;
	writeFileSync(join(outDir, file), data.subarray(i, i + size));
	chunks.push(file);
}
const manifest = { name, totalBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), chunks };
writeFileSync(join(outDir, `${name}.chunks.json`), JSON.stringify(manifest, null, 2));
console.log(`${name}: ${data.length} bytes -> ${chunks.length} chunks of <= ${mib} MiB`);
