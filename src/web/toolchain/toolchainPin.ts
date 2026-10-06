/**
 * The toolchain version this extension release expects. `manifestSha256` replaces Marketplace signing for
 * the downloaded files: the manifest it pins lists the SHA-256 of every chunk and file. Written by
 * `node scripts/make-toolchain-dist.mjs <artifacts> <outDir> --tag <tag> --pin`; empty until a toolchain is published.
 */
export const TOOLCHAIN_PIN = {
	baseUrl: 'https://cdn.jsdelivr.net/gh/Ambeco/vscwClang-toolchain@v1',
	manifestSha256: '',
};
