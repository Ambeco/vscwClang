import { sha256Hex } from './toolchainDownload';

/** One compiled source: the object, the compiler's warnings, and the content hash of every workspace header it included. */
export interface CacheEntry {
	/** Unique per stored object, so a link key can name objects without hashing their bytes. */
	id: number;
	argsKey: string;
	sourceHash: string;
	headers: Map<string, string>;
	object: Uint8Array<ArrayBuffer>;
	stderr: string;
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

/**
 * In-memory, per-session cache of compiled objects, so an edit recompiles only the changed file and the files that
 * include a changed header.
 *
 * An entry is keyed by source path and mode, and is valid while the compile arguments, the source's content hash and the
 * content hash of every workspace header it included are unchanged. Only successful compiles are stored. The total size
 * is capped; the least recently used entries are dropped first.
 */
export class ObjectCache {
	private readonly entries = new Map<string, CacheEntry>();
	private bytes = 0;
	private nextId = 1;

	constructor(private readonly maxBytes = 512 * 1024 * 1024) { }

	get size(): number { return this.entries.size; }

	/** The entry for `key` if it is still valid for `argsKey` and the files as `read` sees them now; else undefined. */
	async lookup(key: string, argsKey: string, sourceHash: string, read: ReadGuestFile): Promise<CacheEntry | undefined> {
		const entry = this.entries.get(key);
		if (!entry || entry.argsKey !== argsKey || entry.sourceHash !== sourceHash) { return undefined; }
		for (const [path, hash] of entry.headers) {
			const bytes = await read(path);
			if (!bytes || await sha256Hex(bytes) !== hash) { return undefined; }
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}

	/** Stores a successful compile; `headers` are guest paths, hashed through `read` now. */
	async store(key: string, argsKey: string, sourceHash: string, headers: string[], object: Uint8Array<ArrayBuffer>, stderr: string, read: ReadGuestFile): Promise<CacheEntry | undefined> {
		const hashes = new Map<string, string>();
		for (const path of headers) {
			const bytes = await read(path);
			if (!bytes) { return undefined; }
			hashes.set(path, await sha256Hex(bytes));
		}
		const old = this.entries.get(key);
		if (old) { this.bytes -= old.object.byteLength; this.entries.delete(key); }
		const entry: CacheEntry = { id: this.nextId++, argsKey, sourceHash, headers: hashes, object, stderr };
		this.entries.set(key, entry);
		this.bytes += object.byteLength;
		for (const [k, e] of this.entries) {
			if (this.bytes <= this.maxBytes || k === key) { break; }
			this.entries.delete(k);
			this.bytes -= e.object.byteLength;
		}
		return entry;
	}

	clear(): void {
		this.entries.clear();
		this.bytes = 0;
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
