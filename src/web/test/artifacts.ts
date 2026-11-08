import { existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Where the node tests find the toolchain: a folder with `bin/`, `sysroot/`, `resource/` and `compile-flags.json`.
 *
 * Order: `VSCWCLANG_ARTIFACTS`, then `./llvm-artifacts`, then the most recently packaged `release/<tag>` (by modification time,
 * since tags do not sort by age) of the sibling `llvm-project` checkout (the output of its `package_release.mjs`). Returns undefined when none has `bin/clang.wasm`, so suites can skip.
 */
export function artifactsRoot(): string | undefined {
	const releases = resolve('..', '..', 'llvm-project', 'release');
	const newest = existsSync(releases) ? readdirSync(releases).map(d => join(releases, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
	return [process.env.VSCWCLANG_ARTIFACTS, resolve('llvm-artifacts'), ...newest]
		.find(dir => !!dir && existsSync(join(dir, 'bin', 'clang.wasm')) && existsSync(join(dir, 'sysroot')));
}

/** A file under the toolchain root's `bin/`; the path may not exist (check with `existsSync`) or the root may be missing (then a path under `llvm-artifacts/bin`). */
export function artifactBin(name: string): string {
	return join(artifactsRoot() ?? resolve('llvm-artifacts'), 'bin', name);
}

/** The root's `sysroot`, `compile-flags.json`, or other non-bin entry. */
export function artifactPath(...parts: string[]): string {
	return join(artifactsRoot() ?? resolve('llvm-artifacts'), ...parts);
}

/** The clang resource dir; `package_release.mjs` nests it as `resource/lib/clang/<version>`, the local copy is flat. */
export function artifactResource(): string {
	const flat = artifactPath('resource');
	const nested = join(flat, 'lib', 'clang');
	return existsSync(nested) ? join(nested, readdirSync(nested)[0]) : flat;
}

/** The lldb reactor: a local `llvm-artifacts` copy, else the sibling `llvm-project` build (newer than the packaged release's, which can predate exports the tests need). */
export function artifactReactor(): string {
	const candidates = [join(resolve('llvm-artifacts'), 'bin', 'lldb-wasm-reactor.wasm'), resolve('..', '..', 'llvm-project', 'build-lldb', 'bin', 'lldb-wasm-reactor.wasm')];
	return candidates.find(existsSync) ?? artifactBin('lldb-wasm-reactor.wasm');
}
