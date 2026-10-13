// Drops the `name` and `.debug_*` custom sections from .wasm files (about a third of the toolchain binaries).
// Usage: node scripts/strip-wasm.mjs <outDir> <in.wasm>...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readLeb(b, p) {
	let result = 0, shift = 0, byte;
	do {
		byte = b[p.pos++];
		result += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	} while (byte & 0x80);
	return result;
}

export function strip(b) {
	const p = { pos: 8 };
	const parts = [b.subarray(0, 8)];
	while (p.pos < b.length) {
		const start = p.pos;
		const id = b[p.pos++];
		const size = readLeb(b, p);
		const end = p.pos + size;
		let drop = false;
		if (id === 0) {
			const q = { pos: p.pos };
			const nameLen = readLeb(b, q);
			const name = b.toString('utf8', q.pos, q.pos + nameLen);
			drop = name === 'name' || name.startsWith('.debug_');
		}
		if (!drop) { parts.push(b.subarray(start, end)); }
		p.pos = end;
	}
	return Buffer.concat(parts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [outDir, ...inputs] = process.argv.slice(2);
	if (!outDir || inputs.length === 0) {
		throw new Error('usage: node scripts/strip-wasm.mjs <outDir> <in.wasm>... (outDir must differ from the input directory; did you mean to pass an output directory first?)');
	}
	mkdirSync(outDir, { recursive: true });
	for (const input of inputs) {
		const before = readFileSync(input);
		const after = strip(before);
		const out = join(outDir, basename(input));
		writeFileSync(out, after);
		console.log(`${basename(input)}: ${(before.length / 1048576).toFixed(1)} MB -> ${(after.length / 1048576).toFixed(1)} MB`);
	}
}
