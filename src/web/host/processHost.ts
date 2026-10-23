import { Wasm } from '@vscode/wasm-wasi';

/**
 * The part of `wasm-wasi-core`'s API that Build, Run, clangd and Debug use to run wasm.
 *
 * Every consumer gets its host from `loadProcessHost()`, so the V2 Worker host can replace `wasm-wasi-core` behind
 * this one seam (documents/design.md "Host").
 */
export type ProcessHost = Pick<Wasm, 'createProcess' | 'createPseudoterminal' | 'createMemoryFileSystem'>;

export function loadProcessHost(): Promise<ProcessHost> {
	return Wasm.load();
}
