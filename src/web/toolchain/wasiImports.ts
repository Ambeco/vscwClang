// wasi_snapshot_preview1 imports that wasm-wasi-core does not implement; a module importing one never
// finishes instantiating, so process.run() hangs without an error (https://github.com/microsoft/vscode-wasm/issues/303).
const UNIMPLEMENTED = ['fd_fdstat_set_rights'];

/** Returns a message naming the unsupported WASI imports of a module, or undefined if it is runnable. */
export function describeUnsupportedImports(imports: readonly { module: string; name: string }[]): string | undefined {
	const bad = imports.filter(i => i.module === 'wasi_snapshot_preview1' && UNIMPLEMENTED.includes(i.name)).map(i => i.name);
	if (bad.length === 0) { return undefined; }
	return `This program imports ${bad.join(', ')}, which wasm-wasi-core does not implement, so it would hang instead of running. `
		+ `Did you mean to link without '--no-gc-sections' (or '--whole-archive')? See https://github.com/microsoft/vscode-wasm/issues/303.`;
}
