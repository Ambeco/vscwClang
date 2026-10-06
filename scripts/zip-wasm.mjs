// Zips files (deflate level 9, one entry per file, flat names): node scripts/zip-wasm.mjs <out.zip> <file>...
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { zipSync } from 'fflate';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
	console.error('usage: node scripts/zip-wasm.mjs <out.zip> <file>...');
	process.exit(1);
}
const entries = Object.fromEntries(inputs.map(f => [basename(f), [readFileSync(f), { level: 9 }]]));
const zip = zipSync(entries);
writeFileSync(out, zip);
console.log(`${out}: ${zip.length} bytes, ${inputs.length} entries`);
