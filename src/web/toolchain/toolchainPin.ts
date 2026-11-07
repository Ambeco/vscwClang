/**
 * The toolchain version this extension release expects. `manifestSha256` replaces Marketplace signing for
 * the downloaded files: the manifest it pins lists the SHA-256 of every chunk and file. Written by
 * `node scripts/make-toolchain-dist.mjs <artifacts> <outDir> --tag <tag> --pin`; empty until a toolchain is published.
 */
export const TOOLCHAIN_PIN = {
	baseUrl: 'https://cdn.jsdelivr.net/gh/Ambeco/llvm-artifacts@v24.0.11/mtdist',
	manifestSha256: '54b8ed763aadc50758f6c5ddba9e1ac462aa15124ef1d7b9fdf7ce4c5ccf0210',
};
