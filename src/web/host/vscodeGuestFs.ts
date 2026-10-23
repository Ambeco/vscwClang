import * as vscode from 'vscode';
import type { GuestFileSystem } from './guestProcess';
import { MountedGuestFs } from './mountedGuestFs';
import type { FsErrno, GuestDirEntry, GuestStat } from './wasiGuest';

export type GuestMount = { guestPath: string; uri: vscode.Uri } | { guestPath: string; fs: GuestFileSystem };

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

/** A `GuestFileSystem` over `vscode.workspace.fs`, rooted at one folder; paths are relative to it (`/` is the folder). */
export class UriGuestFs implements GuestFileSystem {
	constructor(private readonly root: vscode.Uri) {}

	private uri(path: string): vscode.Uri { return vscode.Uri.joinPath(this.root, path); }

	async stat(path: string): Promise<GuestStat> {
		try {
			const stat = await vscode.workspace.fs.stat(this.uri(path));
			return { type: stat.type & vscode.FileType.Directory ? 'dir' : 'file', size: stat.size, mtimeMs: stat.mtime };
		} catch (e) { throw asGuestError(e); }
	}

	async readFile(path: string): Promise<Uint8Array> {
		try { return await vscode.workspace.fs.readFile(this.uri(path)); } catch (e) { throw asGuestError(e); }
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		try { await vscode.workspace.fs.writeFile(this.uri(path), data); } catch (e) { throw asGuestError(e); }
	}

	async readDirectory(path: string): Promise<GuestDirEntry[]> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.uri(path));
			return entries.map(([name, type]) => ({ name, type: type & vscode.FileType.Directory ? 'dir' as const : 'file' as const }));
		} catch (e) { throw asGuestError(e); }
	}

	async createDirectory(path: string): Promise<void> {
		const uri = this.uri(path);
		// workspace.fs.createDirectory succeeds on an existing directory; POSIX mkdir does not.
		try { await vscode.workspace.fs.stat(uri); } catch { await vscode.workspace.fs.createDirectory(uri).then(undefined, e => { throw asGuestError(e); }); return; }
		throw Object.assign(new Error(`${path} already exists`), { code: 'EEXIST' });
	}

	async delete(path: string): Promise<void> {
		const uri = this.uri(path);
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
		try { await vscode.workspace.fs.rename(this.uri(from), this.uri(to), { overwrite: true }); } catch (e) { throw asGuestError(e); }
	}
}

/** Guest paths served from `vscode.workspace.fs` folders and in-memory file systems through a mount table (see `MountedGuestFs`). */
export class VscodeGuestFs extends MountedGuestFs {
	constructor(mounts: GuestMount[]) {
		super(mounts.map(m => ({ guestPath: m.guestPath, fs: 'fs' in m ? m.fs : new UriGuestFs(m.uri) })));
	}
}
