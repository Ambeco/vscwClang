import { unzip } from 'fflate';
import { MemoryGuestFs } from '../host/memoryGuestFs';
import type { PchSet } from './pch';
import type { ToolchainStore } from './toolchainStore';

export interface CompileFlags {
	/** Extra debug-build flags for a clang that can place a guard at every source line; absent on older toolchains (guards stay per block). */
	debugCoverage?: string[];
	compile: Record<string, string[]>;
	link: Record<string, string[]>;
	/** Prebuilt libc++ precompiled headers per slice; absent on toolchains published before they existed. */
	pch?: Record<string, PchSet>;
}

const unzipped = new WeakMap<ToolchainStore, Promise<Record<string, Uint8Array>>>();

/** Unzips `sysroot.zip` once per store, so the Worker host's file systems and the header viewer share the bytes. */
function unzipSysroot(toolchain: ToolchainStore): Promise<Record<string, Uint8Array>> {
	let files = unzipped.get(toolchain);
	if (!files) {
		files = toolchain.getFile('sysroot.zip').then(zipBits => new Promise<Record<string, Uint8Array>>((resolve, reject) =>
			unzip(zipBits, (err, data) => err ? reject(err) : resolve(data))));
		files.catch(() => unzipped.delete(toolchain));
		unzipped.set(toolchain, files);
	}
	return files;
}

/** Every sysroot file by zip path, for editors that open headers clangd points into. */
export const loadSysrootFiles = unzipSysroot;

/** The sysroot and clang resource dir as read-only in-memory file systems for the Worker host (mounted at `/sysroot` and `/resource`). */
export async function loadSysrootGuestFs(toolchain: ToolchainStore): Promise<{ sysroot: MemoryGuestFs; resource: MemoryGuestFs }> {
	const files = await unzipSysroot(toolchain);
	const result = { sysroot: new MemoryGuestFs(), resource: new MemoryGuestFs() };
	for (const [path, content] of Object.entries(files)) {
		if (path.endsWith('/')) { continue; }
		const root = path.startsWith('sysroot/') ? 'sysroot' : 'resource';
		result[root].setFile(path.slice(root.length), content);
	}
	return result;
}

export async function loadCompileFlags(toolchain: ToolchainStore): Promise<CompileFlags> {
	const bits = await toolchain.getFile('compile-flags.json');
	return JSON.parse(new TextDecoder().decode(bits)) as CompileFlags;
}
