import * as vscode from 'vscode';
import type { GuestFileSystem } from './guestProcess';
import type { FsErrno, GuestDirEntry, GuestStat } from './wasiGuest';

export interface GuestMount { guestPath: string; uri: vscode.Uri }

const CODES: Record<string, FsErrno> = {
	FileNotFound: 'ENOENT', FileExists: 'EEXIST', FileNotADirectory: 'ENOTDIR', FileIsADirectory: 'EISDIR', NoPermissions: 'EACCES',
};

/** Turns a `vscode.FileSystemError` into the errno name the guest side understands. */
function asGuestError(e: unknown): Error {
	const name = (e as { code?: string }).code ?? '';
	const message = e instanceof Error ? e.message : String(e);
	const code = CODES[name] ?? (/not.?found|ENOENT/i.test(message) ? 'ENOENT' : /exists/i.test(message) ? 'EEXIST' : /not empty/i.test(message) ? 'ENOTEMPTY' : 'EIO');
	return Object.assign(new Error(message), { code });
}

/**
 * Serves guest paths from `vscode.workspace.fs` through a mount table: the longest matching mount wins.
 *
 * Directories above a mount point (`/`, `/home` for `/home/user`) exist and list the mounts below them, so a
 * program can walk to `/workspace` from the root.
 */
export class VscodeGuestFs implements GuestFileSystem {
	private readonly mounts: GuestMount[];

	constructor(mounts: GuestMount[]) {
		this.mounts = [...mounts].sort((a, b) => b.guestPath.length - a.guestPath.length);
	}

	private locate(path: string): vscode.Uri | undefined {
		for (const mount of this.mounts) {
			if (path === mount.guestPath) { return mount.uri; }
			if (path.startsWith(mount.guestPath === '/' ? '/' : mount.guestPath + '/')) {
				return vscode.Uri.joinPath(mount.uri, path.slice(mount.guestPath.length));
			}
		}
		return undefined;
	}

	/** Names of the mount points directly below `path` when `path` is only an ancestor of mounts. */
	private syntheticChildren(path: string): string[] | undefined {
		const prefix = path === '/' ? '/' : path + '/';
		const below = this.mounts.filter(m => m.guestPath.startsWith(prefix)).map(m => m.guestPath.slice(prefix.length).split('/')[0]);
		return below.length > 0 || path === '/' ? [...new Set(below)] : undefined;
	}

	async stat(path: string): Promise<GuestStat> {
		const uri = this.locate(path);
		if (!uri) {
			if (this.syntheticChildren(path)) { return { type: 'dir', size: 0, mtimeMs: 0 }; }
			throw Object.assign(new Error(`${path} is outside the mounted folders (${this.mounts.map(m => m.guestPath).join(', ')})`), { code: 'ENOENT' });
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			return { type: stat.type & vscode.FileType.Directory ? 'dir' : 'file', size: stat.size, mtimeMs: stat.mtime };
		} catch (e) { throw asGuestError(e); }
	}

	async readFile(path: string): Promise<Uint8Array> {
		const uri = this.requireUri(path);
		try { return await vscode.workspace.fs.readFile(uri); } catch (e) { throw asGuestError(e); }
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		const uri = this.requireUri(path);
		try { await vscode.workspace.fs.writeFile(uri, data); } catch (e) { throw asGuestError(e); }
	}

	async readDirectory(path: string): Promise<GuestDirEntry[]> {
		const uri = this.locate(path);
		if (!uri) {
			const names = this.syntheticChildren(path);
			if (!names) { throw Object.assign(new Error(`${path} is outside the mounted folders`), { code: 'ENOENT' }); }
			return names.map(name => ({ name, type: 'dir' as const }));
		}
		try {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			return entries.map(([name, type]) => ({ name, type: type & vscode.FileType.Directory ? 'dir' as const : 'file' as const }));
		} catch (e) { throw asGuestError(e); }
	}

	async createDirectory(path: string): Promise<void> {
		const uri = this.requireUri(path);
		try {
			// workspace.fs.createDirectory succeeds on an existing directory; POSIX mkdir does not.
			try { await vscode.workspace.fs.stat(uri); } catch { await vscode.workspace.fs.createDirectory(uri); return; }
		} catch (e) { throw asGuestError(e); }
		throw Object.assign(new Error(`${path} already exists`), { code: 'EEXIST' });
	}

	async delete(path: string): Promise<void> {
		const uri = this.requireUri(path);
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			// Some providers delete a non-empty directory even with recursive: false.
			if ((stat.type & vscode.FileType.Directory) && (await vscode.workspace.fs.readDirectory(uri)).length > 0) {
				throw Object.assign(new Error(`${path} is not empty`), { code: 'ENOTEMPTY' });
			}
			await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
		} catch (e) { throw (e as { code?: string }).code === 'ENOTEMPTY' ? e : asGuestError(e); }
	}

	async rename(from: string, to: string): Promise<void> {
		const source = this.requireUri(from);
		const target = this.requireUri(to);
		try { await vscode.workspace.fs.rename(source, target, { overwrite: true }); } catch (e) { throw asGuestError(e); }
	}

	private requireUri(path: string): vscode.Uri {
		const uri = this.locate(path);
		if (!uri) { throw Object.assign(new Error(`${path} is outside the mounted folders (${this.mounts.map(m => m.guestPath).join(', ')}). Did you mean a path under /workspace?`), { code: 'EACCES' }); }
		return uri;
	}
}
