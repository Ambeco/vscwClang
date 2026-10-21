import { fromGuestPath, GUEST_WORKSPACE, toGuestPath } from '../toolchain/guestPaths';

/** Translates between the paths DAP clients use for source files and the guest paths in the program's DWARF. */
export interface PathMapper {
	dapToGuest(path: string): string | undefined;
	guestToDap(guestPath: string): string | undefined;
}

export interface WorkspaceFolderInfo {
	/** `uri.toString()` */
	uri: string;
	scheme: string;
	/** `uri.path` */
	path: string;
	/** `uri.fsPath` */
	fsPath: string;
}

const slashes = (p: string) => p.replace(/\\/g, '/');

/**
 * Maps the first workspace folder to `/workspace`. A DAP client sends a source as an fs path for `file` URIs and as
 * the URI string for every other scheme, so a path is tried against the folder's URI string, path and fs path.
 */
export function workspacePathMapper(folder: WorkspaceFolderInfo): PathMapper {
	return {
		dapToGuest(path) {
			const p = slashes(path);
			const viaUri = toGuestPath(folder.uri, p);
			if (viaUri !== undefined) { return GUEST_WORKSPACE + viaUri.slice(GUEST_WORKSPACE.length).split('/').map(decodeURIComponent).join('/'); }
			return toGuestPath(folder.path, p) ?? toGuestPath(slashes(folder.fsPath), p);
		},
		guestToDap(guestPath) {
			if (folder.scheme === 'file') { return fromGuestPath(slashes(folder.fsPath), guestPath); }
			const rel = fromGuestPath('', guestPath); // "/a/b" below the guest workspace
			return rel === undefined ? undefined : folder.uri.replace(/\/+$/, '') + rel.split('/').map(encodeURIComponent).join('/');
		},
	};
}
