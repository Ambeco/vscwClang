/** Where `wasm-wasi-core` mounts the first workspace folder inside the guest. */
export const GUEST_WORKSPACE = '/workspace';

/** Maps a path under `folderPath` to its guest path; undefined if `filePath` is outside the folder. */
export function toGuestPath(folderPath: string, filePath: string): string | undefined {
	const folder = folderPath.replace(/\/+$/, '');
	if (filePath !== folder && !filePath.startsWith(`${folder}/`)) { return undefined; }
	return GUEST_WORKSPACE + filePath.slice(folder.length);
}

/** Inverse of `toGuestPath`; undefined if `guestPath` is not under the guest workspace. */
export function fromGuestPath(folderPath: string, guestPath: string): string | undefined {
	if (guestPath !== GUEST_WORKSPACE && !guestPath.startsWith(`${GUEST_WORKSPACE}/`)) { return undefined; }
	return folderPath.replace(/\/+$/, '') + guestPath.slice(GUEST_WORKSPACE.length);
}
