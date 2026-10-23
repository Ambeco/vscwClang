import * as vscode from 'vscode';

/**
 * Read-only file system for the toolchain's guest-only `/sysroot` and `/resource` trees.
 *
 * clangd reports locations such as `/sysroot/include/c++/v1/vector`, which exist only inside the wasm process, so
 * the language client maps them to this provider's scheme (`TOOLCHAIN_SCHEME`) and go-to-definition can open them.
 * Files are served from the unzipped `sysroot.zip` already held in memory; keys are `sysroot/...` and `resource/...`.
 */
export class ToolchainFileSystem implements vscode.FileSystemProvider {
	private readonly dirs = new Map<string, Set<string>>();
	private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changed.event;

	constructor(private readonly files: Record<string, Uint8Array>) {
		for (const path of Object.keys(files)) {
			const parts = path.split('/');
			for (let i = 1; i <= parts.length; i++) {
				const parent = parts.slice(0, i - 1).join('/');
				if (!this.dirs.has(parent)) { this.dirs.set(parent, new Set()); }
				this.dirs.get(parent)!.add(parts[i - 1]);
			}
		}
	}

	watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

	stat(uri: vscode.Uri): vscode.FileStat {
		const key = keyOf(uri);
		const file = this.files[key];
		if (file) { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: file.byteLength, permissions: vscode.FilePermission.Readonly }; }
		if (this.dirs.has(key)) { return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly }; }
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		const key = keyOf(uri);
		const children = this.dirs.get(key);
		if (!children) { throw vscode.FileSystemError.FileNotFound(uri); }
		return [...children].map(name => [name, (key ? `${key}/${name}` : name) in this.files ? vscode.FileType.File : vscode.FileType.Directory]);
	}

	readFile(uri: vscode.Uri): Uint8Array {
		const file = this.files[keyOf(uri)];
		if (!file) { throw vscode.FileSystemError.FileNotFound(uri); }
		return file;
	}

	createDirectory(uri: vscode.Uri): never { throw readOnly(uri); }
	writeFile(uri: vscode.Uri): never { throw readOnly(uri); }
	delete(uri: vscode.Uri): never { throw readOnly(uri); }
	rename(oldUri: vscode.Uri): never { throw readOnly(oldUri); }
}

const keyOf = (uri: vscode.Uri) => uri.path.replace(/^\/+|\/+$/g, '');

const readOnly = (uri: vscode.Uri) => vscode.FileSystemError.NoPermissions(`${uri.path} is part of the vscwClang toolchain and is read-only.`);
