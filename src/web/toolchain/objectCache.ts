import { sha256Hex } from './toolchainDownload';

/** Byte storage for cached objects and the cache index; keys are short slash-separated names. */
export interface ByteStore {
	get(key: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
	put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
	/** Removes everything, including entries this process never saw. */
	clear(): Promise<void>;
}

export class MemoryByteStore implements ByteStore {
	private readonly map = new Map<string, Uint8Array<ArrayBuffer>>();
	async get(key: string) { return this.map.get(key); }
	async put(key: string, bytes: Uint8Array<ArrayBuffer>) { this.map.set(key, bytes); }
	async delete(key: string) { this.map.delete(key); }
	async keys() { return [...this.map.keys()]; }
	async clear() { this.map.clear(); }
}

/**
 * A `ByteStore` over the browser's Cache API (`caches`), which Chrome keeps on disk in the profile.
 *
 * Entries are synthetic `https://vscwclang.invalid/<key>` requests. The data is best-effort: the browser may evict the
 * whole origin under storage pressure, which only costs a recompile.
 */
export class CacheStorageByteStore implements ByteStore {
	private static readonly BASE = 'https://vscwclang.invalid/';
	constructor(private readonly name: string) { }

	private open() { return caches.open(this.name); }
	async get(key: string) {
		const hit = await (await this.open()).match(CacheStorageByteStore.BASE + key);
		return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
	}
	async put(key: string, bytes: Uint8Array<ArrayBuffer>) { await (await this.open()).put(CacheStorageByteStore.BASE + key, new Response(bytes)); }
	async delete(key: string) { await (await this.open()).delete(CacheStorageByteStore.BASE + key); }
	async keys() { return (await (await this.open()).keys()).map(r => r.url.slice(CacheStorageByteStore.BASE.length)); }
	async clear() { await caches.delete(this.name); }
}

/** The best store this context offers: the Cache API when present, else memory for the session. */
export function defaultByteStore(name: string): ByteStore {
	return typeof caches === 'undefined' ? new MemoryByteStore() : new CacheStorageByteStore(name);
}

/** A cached compile as `ObjectCache` hands it out. */
export interface CacheEntry {
	/** Content hash of the object, so equal objects share an id and a link key can name objects without their bytes. */
	id: string;
	object: Uint8Array<ArrayBuffer>;
	stderr: string;
}

interface Meta {
	id: string;
	argsKey: string;
	sourceHash: string;
	headers: [string, string][];
	stderr: string;
	size: number;
	lastUsed: number;
}

export type ReadGuestFile = (guestPath: string) => Promise<Uint8Array<ArrayBuffer> | undefined>;

/**
 * Parses `clang -H` output: returns the `/workspace` headers it included and the stderr with the `-H` lines removed.
 *
 * Headers under `/sysroot` and `/resource` are left out because the toolchain version fixes them. A header that is
 * absent when first compiled (an earlier `-I` directory that would now shadow a later one) is not tracked.
 */
export function splitIncludeTrace(stderr: string, workspace: string): { headers: string[]; stderr: string } {
	const headers = new Set<string>();
	const kept: string[] = [];
	for (const line of stderr.split('\n')) {
		const m = /^\.+ (\S.*)$/.exec(line.replace(/\r$/, ''));
		if (m) {
			if (m[1] === workspace || m[1].startsWith(`${workspace}/`)) { headers.add(m[1]); }
		} else if (!line.startsWith('Multiple include guards may be useful for:') && !/^\S+\.(h|hh|hpp|hxx|inc|tcc|ipp)$/.test(line)) {
			kept.push(line);
		}
	}
	return { headers: [...headers], stderr: kept.join('\n') };
}

export interface ObjectCacheOptions {
	/** Total object bytes kept; the least recently used entries go first. */
	maxBytes?: number;
	/** Entries unused for this long are dropped when the cache is loaded or flushed. */
	maxAgeMs?: number;
	/** `store` saves the index when this long has passed since the last save, so a long build that dies keeps its finished objects. */
	saveIntervalMs?: number;
	now?: () => number;
}

export const DEFAULT_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const INDEX_KEY = 'index';
const INDEX_VERSION = 1;
const objectKey = (id: string) => `obj/${id}`;

/**
 * Cache of compiled objects, so an edit recompiles only the changed file and the files that include a changed header.
 *
 * An entry is keyed by source path and mode, and is valid while the compile arguments, the source's content hash and the
 * content hash of every workspace header it included are unchanged. Only successful compiles are stored. Object bytes
 * and a small index (what each entry was built from, its size and last use) live in a `ByteStore`, so a persistent store
 * survives reloads. Entries unused for `maxAgeMs`, then the least recently used past `maxBytes`, are dropped.
 *
 * The index is held in memory and written by `flush()` (call it at the end of a build) and by `store` every `saveIntervalMs`, so a build that dies midway keeps the objects it finished; only orphaned objects are swept by `flush()`. Two tabs sharing one store each
 * write their own index, so the later flush wins and the other tab's objects are deleted as unreferenced; that costs
 * a recompile, never a wrong object. Store failures (quota) are swallowed: the entry simply is not cached.
 */
export class ObjectCache {
	private readonly meta = new Map<string, Meta>();
	private loading: Promise<void> | undefined;
	private dirty = false;
	private maxBytes: number;
	private maxAgeMs: number;
	private readonly now: () => number;
	private readonly saveIntervalMs: number;
	private lastSave = 0;

	constructor(private readonly backing: ByteStore, options: ObjectCacheOptions = {}) {
		this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
		this.maxAgeMs = options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
		this.now = options.now ?? Date.now;
		this.saveIntervalMs = options.saveIntervalMs ?? 5000;
		this.lastSave = this.now();
	}

	/** Replaces the limits (from settings); they apply at the next load or flush. */
	setLimits(limits: { maxBytes?: number; maxAgeMs?: number }): void {
		this.maxBytes = limits.maxBytes ?? this.maxBytes;
		this.maxAgeMs = limits.maxAgeMs ?? this.maxAgeMs;
	}

	async stats(): Promise<{ entries: number; objects: number; bytes: number }> {
		await this.load();
		return { entries: this.meta.size, ...this.totals() };
	}

	/** The entry for `key` if it is still valid for `argsKey` and the files as `read` sees them now; else undefined. */
	async lookup(key: string, argsKey: string, sourceHash: string, read: ReadGuestFile): Promise<CacheEntry | undefined> {
		await this.load();
		const m = this.meta.get(key);
		if (!m || m.argsKey !== argsKey || m.sourceHash !== sourceHash) { return undefined; }
		const current = await Promise.all(m.headers.map(async ([path, hash]) => { const bytes = await read(path); return bytes !== undefined && await sha256Hex(bytes) === hash; }));
		if (!current.every(Boolean)) { return undefined; }
		const object = await this.backing.get(objectKey(m.id)).catch(() => undefined);
		if (!object) {
			this.meta.delete(key);
			this.dirty = true;
			return undefined;
		}
		m.lastUsed = this.now();
		this.dirty = true;
		return { id: m.id, object, stderr: m.stderr };
	}

	/** Stores a successful compile; `headers` are guest paths, hashed through `read` now. Undefined if it could not be kept. */
	async store(key: string, argsKey: string, sourceHash: string, headers: string[], object: Uint8Array<ArrayBuffer>, stderr: string, read: ReadGuestFile): Promise<CacheEntry | undefined> {
		await this.load();
		const hashes: [string, string][] = [];
		for (const path of headers) {
			const bytes = await read(path);
			if (!bytes) { return undefined; }
			hashes.push([path, await sha256Hex(bytes)]);
		}
		const id = await sha256Hex(object);
		try {
			await this.backing.put(objectKey(id), object);
		} catch {
			return undefined;
		}
		this.meta.set(key, { id, argsKey, sourceHash, headers: hashes, stderr, size: object.byteLength, lastUsed: this.now() });
		this.dirty = true;
		if (this.now() - this.lastSave >= this.saveIntervalMs) { await this.saveIndex(); }
		return { id, object, stderr };
	}

	/** Drops expired and over-cap entries, writes the index if anything changed, and deletes objects nothing refers to. */
	async flush(): Promise<void> {
		await this.load();
		this.evict();
		await this.saveIndex();
		await this.deleteUnreferenced();
	}

	private async saveIndex(): Promise<void> {
		this.lastSave = this.now();
		if (!this.dirty) { return; }
		this.dirty = false;
		const index = { version: INDEX_VERSION, entries: [...this.meta] };
		await this.backing.put(INDEX_KEY, new TextEncoder().encode(JSON.stringify(index))).catch(() => { this.dirty = true; });
	}

	/** Removes every entry, from memory and the store. */
	async clear(): Promise<void> {
		this.meta.clear();
		this.loading = Promise.resolve();
		this.dirty = false;
		await this.backing.clear();
	}

	private load(): Promise<void> {
		this.loading ??= (async () => {
			const bytes = await this.backing.get(INDEX_KEY).catch(() => undefined);
			if (bytes) {
				try {
					const index = JSON.parse(new TextDecoder().decode(bytes)) as { version: number; entries: [string, Meta][] };
					if (index.version === INDEX_VERSION) { for (const [k, m] of index.entries) { this.meta.set(k, m); } }
				} catch { /* a corrupt index is an empty cache; its objects are swept by the next flush */ }
			}
			this.evict();
		})();
		return this.loading;
	}

	private totals(): { objects: number; bytes: number } {
		const sizes = new Map<string, number>();
		for (const m of this.meta.values()) { sizes.set(m.id, m.size); }
		return { objects: sizes.size, bytes: [...sizes.values()].reduce((a, b) => a + b, 0) };
	}

	private evict(): void {
		const cutoff = this.now() - this.maxAgeMs;
		for (const [k, m] of this.meta) {
			if (m.lastUsed < cutoff) { this.meta.delete(k); this.dirty = true; }
		}
		if (this.totals().bytes <= this.maxBytes) { return; }
		for (const [k] of [...this.meta].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
			if (this.totals().bytes <= this.maxBytes) { break; }
			this.meta.delete(k);
			this.dirty = true;
		}
	}

	private async deleteUnreferenced(): Promise<void> {
		const live = new Set([...this.meta.values()].map(m => objectKey(m.id)));
		for (const k of await this.backing.keys().catch(() => [] as string[])) {
			if (k.startsWith('obj/') && !live.has(k)) { await this.backing.delete(k).catch(() => undefined); }
		}
	}
}

/** What the last successful link produced, so an unchanged tree can skip linking when the output file is untouched. */
export interface LinkRecord {
	key: string;
	mtime: number;
	stderr: string;
}

export async function hashText(text: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(text));
}
