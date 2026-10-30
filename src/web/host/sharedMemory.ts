export interface MemoryLimits { initial: number; maximum: number }

/**
 * Creates the shared memory a wasi-threads module imports (`env.memory`), with the limits its binary declares.
 * Returns undefined for a module that owns its memory.
 *
 * @helper createSharedMemory
 */
export function createSharedMemory(wasm: Uint8Array): WebAssembly.Memory | undefined {
	const limits = sharedMemoryLimits(wasm);
	return limits && newSharedMemory(limits);
}

/** A fresh shared memory; each process needs its own, so callers that cache a module keep the limits and call this per run. */
export function newSharedMemory({ initial, maximum }: MemoryLimits): WebAssembly.Memory {
	return new WebAssembly.Memory({ initial, maximum, shared: true });
}

/**
 * The limits of the shared memory a wasi-threads module imports, or undefined for a module that owns its memory.
 *
 * `WebAssembly.Module.imports` does not expose limits, so the import section is read by hand. The linker defaults a
 * shared memory's maximum to its minimum unless `--max-memory` is given, which is why a missing maximum is an error.
 */
export function sharedMemoryLimits(wasm: Uint8Array): MemoryLimits | undefined {
	let i = 8;
	const u32 = (): number => {
		let value = 0, shift = 0;
		for (;;) {
			const byte = wasm[i++];
			value |= (byte & 0x7f) << shift;
			if (!(byte & 0x80)) { return value >>> 0; }
			shift += 7;
		}
	};
	while (i < wasm.length) {
		const section = wasm[i++];
		const size = u32();
		const end = i + size;
		if (section === 2) {
			for (let count = u32(); count > 0; count--) {
				const moduleLength = u32();
				i += moduleLength;
				const nameLength = u32();
				const name = new TextDecoder().decode(wasm.subarray(i, i + nameLength));
				i += nameLength;
				const kind = wasm[i++];
				if (kind === 2) {
					const flags = wasm[i++];
					const initial = u32();
					const maximum = (flags & 1) ? u32() : undefined;
					if (name !== 'memory') { continue; }
					if (!(flags & 2) || maximum === undefined) {
						throw new Error('vscwClang: the module imports a memory that is not shared and bounded. Did you mean to link with -Wl,--import-memory,--shared-memory,--max-memory=<bytes>?');
					}
					return { initial, maximum };
				}
				if (kind === 0) { u32(); }
				else if (kind === 1) { i++; const tableFlags = wasm[i++]; u32(); if (tableFlags & 1) { u32(); } }
				else if (kind === 3) { i += 2; }
			}
		}
		i = end;
	}
	return undefined;
}
