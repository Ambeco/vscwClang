/**
 * The toolchain version this extension release expects. `manifestSha256` replaces Marketplace signing for
 * the downloaded files: the manifest it pins lists the SHA-256 of every chunk and file. Written by
 * `node scripts/make-toolchain-dist.mjs <artifacts> <outDir> --tag <tag> --pin`; empty until a toolchain is published.
 */
export const TOOLCHAIN_PIN = {
	baseUrl: 'https://cdn.jsdelivr.net/gh/Ambeco/llvm-artifacts@v24.0.9/mtdist',
	manifestSha256: '58ec5a3262abc99f5d239995a14591b1343847398a28a1fd477d24ece34f42c8',
};
