import { Wasm, type MemoryFileSystem } from '@vscode/wasm-wasi';
import { unzip } from 'fflate';
import type { ToolchainStore } from './toolchainStore';

export interface SysrootFs {
	sysroot: MemoryFileSystem;
	resource: MemoryFileSystem;
}

export interface CompileFlags {
	compile: Record<string, string[]>;
	link: Record<string, string[]>;
}

/** Unzips `sysroot.zip` (entries under `sysroot/` and `resource/`) into two memory file systems. */
export async function loadSysroot(wasm: Wasm, toolchain: ToolchainStore): Promise<SysrootFs> {
	const zipBits = await toolchain.getFile('sysroot.zip');
	const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
		unzip(zipBits, (err, data) => err ? reject(err) : resolve(data)));
	const result: SysrootFs = { sysroot: await wasm.createMemoryFileSystem(), resource: await wasm.createMemoryFileSystem() };
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
