import { splitFlags } from '../toolchain/flagPolicy';
import { GUEST_WORKSPACE } from '../toolchain/guestPaths';

/**
 * clangd's `fallbackFlags` initialization option: the build's compile flags plus the `vscwclang.flags` setting,
 * used for any file with no `compile_commands.json`/`compile_flags.txt` entry, so it still finds the wasm sysroot
 * and libc++ headers (the same flags `build()` uses). (clangd has no `-extra-arg` command-line option.)
 *
 * Link-only flags are dropped, and clangd gets no `-std` of its own unless the user sets one.
 */
export function fallbackFlags(compileFlags: readonly string[], userFlags: readonly string[]): string[] {
	let userCompile: string[] = [];
	try { userCompile = splitFlags(userFlags, GUEST_WORKSPACE).compile; } catch { /* malformed setting: build() reports it; clangd just goes without */ }
	return [...compileFlags, ...userCompile];
}
