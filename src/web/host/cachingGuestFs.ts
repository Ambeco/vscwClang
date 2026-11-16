import type { GuestFileSystem } from './guestProcess';
import type { GuestDirEntry, GuestStat } from './wasiGuest';

interface Entry { stat: GuestStat; bytes: Promise<Uint8Array>; size: number }

/**
 * A `GuestFileSystem` that reads each file from the inner one once for all of a process's threads.
 *
 * Every thread Worker has its own descriptor table and whole-file cache, so a threaded clangd otherwise re-reads every
 * header from the browser's file system once per thread and per open. Here a `stat` that shows an unchanged size and
 * mtime keeps the cached bytes, a changed one drops them, and any write, delete or rename through this wrapper drops
 * the path. Concurrent reads of one path share one inner read.
 *
 * A file whose mtime is 0 (some providers report none) is never cached, since nothing could tell it changed. The
 * cache is bounded (`maxBytes`, `maxFileBytes`) and evicts the least recently read file first. Files changed behind
 * this wrapper are noticed at the next `stat`, which is what every open does first.
 *
 * @helper
 */
export class CachingGuestFs implements GuestFileSystem {
	private readonly entries = new Map<string, Entry>();
	private lastStat = new Map<string, GuestStat>();
	private cachedBytes = 0;
	hits = 0;
	misses = 0;
	dropped = 0;

	constructor(private readonly inner: GuestFileSystem, private readonly maxBytes = 192 * 1024 * 1024, private readonly maxFileBytes = 24 * 1024 * 1024) {}

	async stat(path: string): Promise<GuestStat> {
		const stat = await this.inner.stat(path);
		const entry = this.entries.get(path);
		if (entry && (entry.stat.size !== stat.size || entry.stat.mtimeMs !== stat.mtimeMs)) { this.drop(path); }
		if (stat.type === 'file') {
			this.lastStat.set(path, stat);
			if (this.lastStat.size > 20000) { this.lastStat = new Map([...this.lastStat].slice(-10000)); }
		}
		return stat;
	}

	async readFile(path: string): Promise<Uint8Array> {
		const entry = this.entries.get(path);
		if (entry) {
			this.hits++;
			this.entries.delete(path);
			this.entries.set(path, entry);
			return entry.bytes;
		}
		this.misses++;
		const stat = this.lastStat.get(path);
		if (!stat || stat.type !== 'file' || !(stat.mtimeMs > 0) || stat.size > this.maxFileBytes) { return this.inner.readFile(path); }
		const bytes = this.inner.readFile(path);
		const fresh: Entry = { stat, bytes, size: stat.size };
		this.entries.set(path, fresh);
		this.cachedBytes += fresh.size;
		bytes.then(
			data => {
				if (this.entries.get(path) !== fresh) { return; }
				// A file that changed between the stat and the read is not what the stat described.
				if (data.length !== stat.size) { this.drop(path); return; }
				this.evict();
			},
			() => { if (this.entries.get(path) === fresh) { this.drop(path); } });
		return bytes;
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		this.drop(path);
		try { await this.inner.writeFile(path, data); } finally { this.drop(path); }
	}

	readDirectory(path: string): Promise<GuestDirEntry[]> { return this.inner.readDirectory(path); }
	createDirectory(path: string): Promise<void> { return this.inner.createDirectory(path); }

	async delete(path: string): Promise<void> {
		this.dropTree(path);
		try { await this.inner.delete(path); } finally { this.dropTree(path); }
	}

	async rename(from: string, to: string): Promise<void> {
		this.dropTree(from);
		this.dropTree(to);
		try { await this.inner.rename(from, to); } finally { this.dropTree(from); this.dropTree(to); }
	}

	private drop(path: string): void {
		const entry = this.entries.get(path);
		if (entry) { this.entries.delete(path); this.cachedBytes -= entry.size; this.dropped++; }
		this.lastStat.delete(path);
	}

	private dropTree(path: string): void {
		this.drop(path);
		const prefix = `${path.replace(/\/$/, '')}/`;
		for (const key of [...this.entries.keys()]) { if (key.startsWith(prefix)) { this.drop(key); } }
		for (const key of [...this.lastStat.keys()]) { if (key.startsWith(prefix)) { this.lastStat.delete(key); } }
	}

	private evict(): void {
		for (const [path, entry] of this.entries) {
			if (this.cachedBytes <= this.maxBytes) { break; }
			this.entries.delete(path);
			this.cachedBytes -= entry.size;
		}
	}

	describe(): string { return `read cache: ${this.hits} hits, ${this.misses} misses, ${this.dropped} dropped, ${Math.round(this.cachedBytes / 1048576)} MiB held`; }
}
