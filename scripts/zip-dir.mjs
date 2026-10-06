// Zips directories recursively under given archive prefixes: node scripts/zip-dir.mjs <out.zip> <prefix>=<dir>...
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const [out, ...mappings] = process.argv.slice(2);
if (!out || mappings.length === 0 || mappings.some(m => !m.includes('='))) {
	console.error('usage: node scripts/zip-dir.mjs <out.zip> <prefix>=<dir>...  (e.g. sysroot=llvm-artifacts/sysroot)');
	process.exit(1);
}
const entries = {};
function walk(dir, prefix) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			walk(path, `${prefix}/${name}`);
		} else {
			entries[`${prefix}/${name}`] = [readFileSync(path), { level: 6 }];
		}
	}
}
for (const m of mappings) {
	const i = m.indexOf('=');
	walk(m.slice(i + 1), m.slice(0, i));
}
const zip = zipSync(entries);
writeFileSync(out, zip);
console.log(`${out}: ${zip.length} bytes, ${Object.keys(entries).length} files`);
