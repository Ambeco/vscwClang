import type { GuestFileSystem } from './guestProcess';
import type { GuestDirEntry, GuestStat } from './wasiGuest';

const enoent = (path: string) => Object.assign(new Error(`${path} does not exist`), { code: 'ENOENT' });
const eacces = (path: string) => Object.assign(new Error(`${path} is read-only`), { code: 'EACCES' });

/**
 * An in-memory `GuestFileSystem` (paths like `/include/stdio.h`; directories are implied by the files below them).
 *
 * Used for the toolchain's `/sysroot` and `/resource` and the build's `/obj`. Read-only by default: a guest write
 * fails with EACCES, and the host fills it with `setFile`.
 */
export class MemoryGuestFs implements GuestFileSystem {
	private readonly files = new Map<string, Uint8Array>();
	private readonly dirs = new Set<string>(['/']);

	constructor(private readonly writable = false) {}

	/** Host-side add or replace, regardless of `writable`. */
	setFile(path: string, data: Uint8Array): void {
		const norm = path.startsWith('/') ? path : '/' + path;
		this.files.set(norm, data);
		for (let i = norm.indexOf('/', 1); i !== -1; i = norm.indexOf('/', i + 1)) { this.dirs.add(norm.slice(0, i)); }
	}

	async stat(path: string): Promise<GuestStat> {
		const file = this.files.get(path);
		if (file) { return { type: 'file', size: file.length, mtimeMs: 0 }; }
		if (this.dirs.has(path)) { return { type: 'dir', size: 0, mtimeMs: 0 }; }
		throw enoent(path);
	}

	async readFile(path: string): Promise<Uint8Array> {
		const file = this.files.get(path);
		if (!file) { throw this.dirs.has(path) ? Object.assign(new Error(`${path} is a directory`), { code: 'EISDIR' }) : enoent(path); }
		return file;
	}

	async readDirectory(path: string): Promise<GuestDirEntry[]> {
		if (!this.dirs.has(path)) { throw this.files.has(path) ? Object.assign(new Error(`${path} is not a directory`), { code: 'ENOTDIR' }) : enoent(path); }
		const prefix = path === '/' ? '/' : path + '/';
		const names = new Map<string, 'file' | 'dir'>();
		for (const key of [...this.files.keys(), ...this.dirs]) {
			if (key.length > prefix.length && key.startsWith(prefix)) {
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf('/');
				if (slash === -1) { if (!names.has(rest)) { names.set(rest, this.dirs.has(key) ? 'dir' : 'file'); } } else { names.set(rest.slice(0, slash), 'dir'); }
			}
		}
		return [...names].map(([name, type]) => ({ name, type }));
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		if (!this.writable) { throw eacces(path); }
		this.setFile(path, data);
	}

	async createDirectory(path: string): Promise<void> {
		if (!this.writable) { throw eacces(path); }
		if (this.files.has(path) || this.dirs.has(path)) { throw Object.assign(new Error(`${path} already exists`), { code: 'EEXIST' }); }
		this.dirs.add(path);
	}

	async delete(path: string): Promise<void> {
		if (!this.writable) { throw eacces(path); }
		if (!this.files.delete(path)) { throw enoent(path); }
	}

	async rename(from: string, to: string): Promise<void> {
		if (!this.writable) { throw eacces(from); }
		const file = this.files.get(from);
		if (!file) { throw enoent(from); }
		this.files.delete(from);
		this.setFile(to, file);
	}
}
