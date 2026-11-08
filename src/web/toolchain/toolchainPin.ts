/**
 * The toolchain version this extension release expects. `manifestSha256` replaces Marketplace signing for
 * the downloaded files: the manifest it pins lists the SHA-256 of every chunk and file. Written by
 * `node scripts/make-toolchain-dist.mjs <artifacts> <outDir> --tag <tag> --pin`; empty until a toolchain is published.
 */
export const TOOLCHAIN_PIN = {
	baseUrl: 'https://cdn.jsdelivr.net/gh/Ambeco/llvm-artifacts@v24.0.12/mtdist',
	manifestSha256: 'ff3b5ac1f219f892058ce83ffcbad6fc5f173cf38b288f5e7ba925bac5492547',
};
