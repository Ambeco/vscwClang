/** URI schemes of virtual repository file systems, where a written file would show up as a pending change. */
const VIRTUAL_REPO_SCHEMES = new Set(['vscode-vfs', 'github', 'azurerepos']);

/**
 * Whether build artifacts may go inside the workspace folder. `writable` is what
 * `vscode.workspace.fs.isWritableFileSystem(scheme)` returned (undefined = unknown, which is tried optimistically).
 */
export function artifactsBelongInFolder(scheme: string, writable: boolean | undefined): boolean {
	return writable !== false && !VIRTUAL_REPO_SCHEMES.has(scheme);
}

/** Folder (relative to the workspace folder or extension storage) holding one mode's `.wasm` and logs. */
export function artifactSubdir(mode: 'debug' | 'release'): string {
	return `.vscwclang/${mode}`;
}

/** Stable, filesystem-safe key for a workspace folder URI, so each folder gets its own directory in extension storage. */
export function storageKeyFor(folderUri: string): string {
	folderUri = folderUri.replace(/\/+$/, '');
	let hash = 0x811c9dc5;
	for (let i = 0; i < folderUri.length; i++) { hash = Math.imul(hash ^ folderUri.charCodeAt(i), 0x01000193) >>> 0; }
	const name = folderUri.replace(/\/+$/, '').split('/').pop()?.replace(/[^\w.-]+/g, '_') || 'folder';
	return `${name}-${hash.toString(16).padStart(8, '0')}`;
}
