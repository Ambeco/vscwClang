/** Where `wasm-wasi-core` mounts the first workspace folder inside the guest. */
export const GUEST_WORKSPACE = '/workspace';

/** @helper Maps a path under `folderPath` to its guest path; undefined if `filePath` is outside the folder. */
export function toGuestPath(folderPath: string, filePath: string): string | undefined {
	const folder = folderPath.replace(/\/+$/, '');
	if (filePath !== folder && !filePath.startsWith(`${folder}/`)) { return undefined; }
	return GUEST_WORKSPACE + filePath.slice(folder.length);
}

/** @helper Inverse of `toGuestPath`; undefined if `guestPath` is not under the guest workspace. */
export function fromGuestPath(folderPath: string, guestPath: string): string | undefined {
	if (guestPath !== GUEST_WORKSPACE && !guestPath.startsWith(`${GUEST_WORKSPACE}/`)) { return undefined; }
	return folderPath.replace(/\/+$/, '') + guestPath.slice(GUEST_WORKSPACE.length);
}

/**
 * Drops a leading `${workspaceFolder}/` (or `${workspaceRoot}/`) so a setting that is already workspace-relative on
 * the host accepts the cpptools spelling. Settings that reach the compiler or program use `resolveVariables` instead.
 *
 * @helper
 */
export function stripWorkspaceFolder(path: string): string {
	return path.replace(/^\$\{(?:workspaceFolder|workspaceRoot)\}[\\/]?/, '');
}

/** URI scheme under which the toolchain's guest-only `/sysroot` and `/resource` files are shown in editors. */
export const TOOLCHAIN_SCHEME = 'vscwclang-toolchain';

/** @helper True for `/sysroot` and `/resource` guest paths and what lies under them, which have no host file system. */
export function isToolchainGuestPath(guestPath: string): boolean {
	return /^\/(sysroot|resource)(\/|$)/.test(guestPath);
}
