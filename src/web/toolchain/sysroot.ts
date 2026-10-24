import { type MemoryFileSystem } from '@vscode/wasm-wasi';
import type { ProcessHost } from '../host/processHost';
import { unzip } from 'fflate';
import { MemoryGuestFs } from '../host/memoryGuestFs';
import type { ToolchainStore } from './toolchainStore';

export interface SysrootFs {
	sysroot: MemoryFileSystem;
	resource: MemoryFileSystem;
	/** Every file by zip path (`sysroot/...`, `resource/...`), kept so editors can open headers clangd points into. */
	files: Record<string, Uint8Array>;
}

export interface CompileFlags {
	compile: Record<string, string[]>;
	link: Record<string, string[]>;
}

const unzipped = new WeakMap<ToolchainStore, Promise<Record<string, Uint8Array>>>();

/** Unzips `sysroot.zip` once per store, so the wasm-wasi-core file systems and the Worker host's share the bytes. */
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

/** Unzips `sysroot.zip` (entries under `sysroot/` and `resource/`) into two memory file systems. */
export async function loadSysroot(wasm: ProcessHost, toolchain: ToolchainStore): Promise<SysrootFs> {
	const files = await unzipSysroot(toolchain);
	const result: SysrootFs = { sysroot: await wasm.createMemoryFileSystem(), resource: await wasm.createMemoryFileSystem(), files };
	const made = { sysroot: new Set<string>(), resource: new Set<string>() };
	for (const [path, content] of Object.entries(files)) {
		const root = path.startsWith('sysroot/') ? 'sysroot' : 'resource';
		const rel = path.slice(root.length);
		const parts = rel.split('/').slice(1, -1);
		let dir = '';
		for (const part of parts) {
			dir = dir ? `${dir}/${part}` : part;
			if (!made[root].has(dir)) {
				result[root].createDirectory(dir);
				made[root].add(dir);
			}
		}
		result[root].createFile(rel.slice(1), content);
	}
	return result;
}

export async function loadCompileFlags(toolchain: ToolchainStore): Promise<CompileFlags> {
	const bits = await toolchain.getFile('compile-flags.json');
	return JSON.parse(new TextDecoder().decode(bits)) as CompileFlags;
}
