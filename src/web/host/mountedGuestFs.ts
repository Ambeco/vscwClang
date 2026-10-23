import type { GuestFileSystem } from './guestProcess';
import type { GuestDirEntry, GuestStat } from './wasiGuest';

export interface FsMount { guestPath: string; fs: GuestFileSystem }

/**
 * Serves guest paths from several `GuestFileSystem`s through a mount table: the longest matching mount wins and the
 * mounted file system sees the path relative to its mount point (`/` for the mount point itself).
 *
 * Directories above a mount point (`/`, `/home` for `/home/user`) exist and list the mounts below them, so a
 * program can walk to `/workspace` from the root.
 */
export class MountedGuestFs implements GuestFileSystem {
	private readonly mounts: FsMount[];

	constructor(mounts: FsMount[]) {
		this.mounts = [...mounts].sort((a, b) => b.guestPath.length - a.guestPath.length);
	}

	private locate(path: string): { fs: GuestFileSystem; rel: string } | undefined {
		for (const mount of this.mounts) {
			if (path === mount.guestPath) { return { fs: mount.fs, rel: '/' }; }
			if (path.startsWith(mount.guestPath === '/' ? '/' : mount.guestPath + '/')) { return { fs: mount.fs, rel: path.slice(mount.guestPath.length) }; }
		}
		return undefined;
	}

	/** Names of the mount points directly below `path` when `path` is only an ancestor of mounts. */
	private syntheticChildren(path: string): string[] | undefined {
		const prefix = path === '/' ? '/' : path + '/';
		const below = this.mounts.filter(m => m.guestPath.startsWith(prefix)).map(m => m.guestPath.slice(prefix.length).split('/')[0]);
		return below.length > 0 || path === '/' ? [...new Set(below)] : undefined;
	}

	private outside(path: string, hint: string): Error {
		return Object.assign(new Error(`${path} is outside the mounted folders (${this.mounts.map(m => m.guestPath).join(', ')})${hint}`), { code: hint ? 'EACCES' : 'ENOENT' });
	}

	private require(path: string): { fs: GuestFileSystem; rel: string } {
		const found = this.locate(path);
		if (!found) { throw this.outside(path, '. Did you mean a path under /workspace?'); }
		return found;
	}

	async stat(path: string): Promise<GuestStat> {
		const found = this.locate(path);
		if (!found) {
			if (this.syntheticChildren(path)) { return { type: 'dir', size: 0, mtimeMs: 0 }; }
			throw this.outside(path, '');
		}
		return found.fs.stat(found.rel);
	}

	async readFile(path: string): Promise<Uint8Array> { const m = this.require(path); return m.fs.readFile(m.rel); }
	async writeFile(path: string, data: Uint8Array): Promise<void> { const m = this.require(path); return m.fs.writeFile(m.rel, data); }
	async createDirectory(path: string): Promise<void> { const m = this.require(path); return m.fs.createDirectory(m.rel); }
	async delete(path: string): Promise<void> { const m = this.require(path); return m.fs.delete(m.rel); }

	async rename(from: string, to: string): Promise<void> {
		const source = this.require(from);
		const target = this.require(to);
		if (source.fs !== target.fs) { throw Object.assign(new Error(`cannot rename ${from} to ${to}: they are on different mounts`), { code: 'EACCES' }); }
		return source.fs.rename(source.rel, target.rel);
	}

	async readDirectory(path: string): Promise<GuestDirEntry[]> {
		const found = this.locate(path);
		if (!found) {
			const names = this.syntheticChildren(path);
			if (!names) { throw this.outside(path, ''); }
			return names.map(name => ({ name, type: 'dir' as const }));
		}
		return found.fs.readDirectory(found.rel);
	}
}
