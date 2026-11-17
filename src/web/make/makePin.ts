/**
 * The optional Make pack (GNU make 4.4.1 as `make.wasm`) this extension release expects. Separate from the toolchain pin so
 * adding or updating it never changes the pinned toolchain. Written by `node scripts/build-make-wasm.mjs --pin`; empty until published.
 */
export const MAKE_PACK_PIN = {
	baseUrl: 'https://cdn.jsdelivr.net/gh/Ambeco/llvm-artifacts@make-4.4.1-1/makedist',
	manifestSha256: '',
};
