import { unzip } from 'fflate';

export interface PayloadChunk {
	name: string;
	size: number;
	sha256: string;
}

export interface ManifestFile {
	/** Size of the final bytes (after unzipping a `zip` payload). */
	size: number;
	/** SHA-256 of the final bytes. */
	sha256: string;
	/** `zip`: the reassembled payload is a zip with one entry named like the file. `raw`: the payload is the file. */
	payloadKind: 'zip' | 'raw';
	chunks: PayloadChunk[];
}

export interface ToolchainManifest {
	format: 1;
	tag: string;
	files: Record<string, ManifestFile>;
}

/** Flat key/value byte storage; the vscode-backed implementation lives in toolchainStore.ts. */
export interface ByteStore {
	size(name: string): Promise<number | undefined>;
	read(name: string): Promise<Uint8Array<ArrayBuffer>>;
	write(name: string, bytes: Uint8Array): Promise<void>;
	delete(name: string): Promise<void>;
}

export interface DownloadOptions {
	/** Directory URL that holds `manifest.json` and the payload chunks; with or without a trailing slash. */
	baseUrl: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (doneBytes: number, totalBytes: number) => void;
	/** Extra attempts per chunk after the first. */
	retries?: number;
	retryDelayMs?: number;
	concurrency?: number;
}

export class HttpStatusError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const joinUrl = (baseUrl: string, name: string) => `${baseUrl.replace(/\/+$/, '')}/${name}`;
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function parseManifest(text: string): ToolchainManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		throw new Error(`toolchain manifest is not valid JSON (${(e as Error).message}). Did the host return an HTML error page instead of manifest.json?`);
	}
	const m = raw as Partial<ToolchainManifest> | null;
	if (!m || m.format !== 1 || typeof m.tag !== 'string' || typeof m.files !== 'object' || m.files === null) {
		throw new Error(`toolchain manifest has an unsupported shape (format ${(m as { format?: unknown } | null)?.format}); this extension reads format 1. Did you mean to update the extension?`);
	}
	for (const [name, f] of Object.entries(m.files)) {
		const ok = typeof f.size === 'number' && typeof f.sha256 === 'string' && (f.payloadKind === 'zip' || f.payloadKind === 'raw')
			&& Array.isArray(f.chunks) && f.chunks.length > 0
			&& f.chunks.every(c => typeof c.name === 'string' && typeof c.size === 'number' && typeof c.sha256 === 'string');
		if (!ok) { throw new Error(`toolchain manifest entry '${name}' is malformed (needs size, sha256, payloadKind zip|raw, and a non-empty chunks list).`); }
	}
	return m as ToolchainManifest;
}

/**
 * Returns the manifest, hash-checked against `pinnedSha256` when given. The manifest is cached under
 * `manifest-<sha>.json`, so a pinned toolchain needs no network once downloaded. Without a pin (a developer's
 * override URL) it is always fetched and trusted as served.
 */
export async function resolveManifest(store: ByteStore, opts: DownloadOptions, pinnedSha256: string | undefined): Promise<{ manifest: ToolchainManifest; sha256: string }> {
	const decoder = new TextDecoder();
	if (pinnedSha256) {
		const cacheName = `manifest-${pinnedSha256}.json`;
		if (await store.size(cacheName) !== undefined) {
			const cached = await store.read(cacheName);
			if (await sha256Hex(cached) === pinnedSha256) { return { manifest: parseManifest(decoder.decode(cached)), sha256: pinnedSha256 }; }
			await store.delete(cacheName);
		}
	}
	const url = joinUrl(opts.baseUrl, 'manifest.json');
	const bytes = await fetchWithRetry(url, undefined, opts);
	const sha256 = await sha256Hex(bytes);
	if (pinnedSha256 && sha256 !== pinnedSha256) {
		throw new Error(`toolchain manifest from ${host(url)} has SHA-256 ${sha256}, but this extension pins ${pinnedSha256}. The host may serve a different toolchain version than this extension expects; did you mean to update the extension?`);
	}
	const manifest = parseManifest(decoder.decode(bytes));
	await store.write(`manifest-${sha256}.json`, bytes);
	return { manifest, sha256 };
}

/** Bytes still to download for `names` (0 when all are cached at the right size). */
export async function missingBytes(manifest: ToolchainManifest, store: ByteStore, keyDir: string, names: string[]): Promise<number> {
	let total = 0;
	for (const name of names) {
		const file = fileEntry(manifest, name);
		if (await store.size(`${keyDir}/${name}`) !== file.size) { total += file.chunks.reduce((n, c) => n + c.size, 0); }
	}
	return total;
}

/**
 * Returns the verified bytes of `name`, downloading and caching them (as `<keyDir>/<name>`) on a cache miss.
 *
 * A cached file is trusted only if its size and SHA-256 match the manifest; otherwise it is deleted and
 * fetched again. Nothing is cached unless every chunk and the final bytes verified.
 */
export async function getFile(manifest: ToolchainManifest, store: ByteStore, keyDir: string, name: string, opts: DownloadOptions, tracker: ProgressTracker = new ProgressTracker(opts, 0)): Promise<Uint8Array<ArrayBuffer>> {
	const file = fileEntry(manifest, name);
	const cacheName = `${keyDir}/${name}`;
	if (await store.size(cacheName) === file.size) {
		const cached = await store.read(cacheName);
		if (await sha256Hex(cached) === file.sha256) { return cached; }
	}
	await store.delete(cacheName);

	const payloadSize = file.chunks.reduce((n, c) => n + c.size, 0);
	const payload = new Uint8Array(payloadSize);
	const offsets: number[] = [];
	file.chunks.reduce((off, c) => { offsets.push(off); return off + c.size; }, 0);
	let next = 0;
	const worker = async () => {
		while (next < file.chunks.length) {
			const i = next++;
			const chunk = file.chunks[i];
			const bytes = await fetchWithRetry(joinUrl(opts.baseUrl, chunk.name), chunk, opts, tracker);
			payload.set(bytes, offsets[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, file.chunks.length) }, worker));

	const bytes = file.payloadKind === 'zip' ? await extractZipEntry(payload, name) : payload;
	if (bytes.byteLength !== file.size) {
		throw new Error(`${name}: expected ${file.size} bytes after ${file.payloadKind === 'zip' ? 'unzipping' : 'reassembly'}, got ${bytes.byteLength}. Was the manifest generated from a different build than the chunks?`);
	}
	const actual = await sha256Hex(bytes);
	if (actual !== file.sha256) {
		throw new Error(`${name}: SHA-256 mismatch (got ${actual}, manifest ${file.sha256}); not cached.`);
	}
	await store.write(cacheName, bytes);
	return bytes;
}

function fileEntry(manifest: ToolchainManifest, name: string): ManifestFile {
	const file = manifest.files[name];
	if (!file) {
		throw new Error(`toolchain ${manifest.tag} has no file '${name}' (it has: ${Object.keys(manifest.files).join(', ')}). Did you mean to update the extension or the toolchain URL?`);
	}
	return file;
}

function extractZipEntry(zip: Uint8Array, name: string): Promise<Uint8Array<ArrayBuffer>> {
	return new Promise((resolve, reject) => unzip(zip, { filter: f => f.name === name }, (err, data) => {
		if (err) { reject(new Error(`${name}: cannot unzip downloaded payload (${err.message ?? err}); it may be truncated.`)); return; }
		const entry = data[name];
		if (!entry) { reject(new Error(`${name}: the downloaded zip has no entry named '${name}'.`)); return; }
		resolve(entry as Uint8Array<ArrayBuffer>);
	}));
}

/** Aggregates per-chunk byte counts into one progress stream; a failed attempt's bytes are taken back. */
export class ProgressTracker {
	private done = 0;
	constructor(private readonly opts: Pick<DownloadOptions, 'onProgress'>, private readonly total: number) {}
	add(bytes: number) { this.done += bytes; this.opts.onProgress?.(this.done, this.total); }
}

async function fetchWithRetry(url: string, chunk: PayloadChunk | undefined, opts: DownloadOptions, tracker?: ProgressTracker): Promise<Uint8Array<ArrayBuffer>> {
	const attempts = (opts.retries ?? 2) + 1;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		let counted = 0;
		try {
			const bytes = await fetchOnce(url, chunk?.size, opts, n => { counted += n; tracker?.add(n); });
			if (chunk) {
				if (bytes.byteLength !== chunk.size) { throw new Error(`${chunk.name}: got ${bytes.byteLength} bytes, manifest says ${chunk.size}`); }
				const actual = await sha256Hex(bytes);
				if (actual !== chunk.sha256) { throw new Error(`${chunk.name}: SHA-256 mismatch (got ${actual}, manifest ${chunk.sha256})`); }
			}
			return bytes;
		} catch (e) {
			tracker?.add(-counted);
			lastError = e;
			if (opts.signal?.aborted) { throw new Error(`download of ${host(url)} was cancelled; files already downloaded are kept, so running it again resumes.`); }
			const permanent = e instanceof HttpStatusError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408;
			if (permanent || attempt === attempts) { break; }
			await new Promise(r => setTimeout(r, (opts.retryDelayMs ?? 500) * 2 ** (attempt - 1)));
		}
	}
	throw describeFailure(url, lastError);
}

function describeFailure(url: string, e: unknown): Error {
	if (e instanceof HttpStatusError) {
		const hint = e.status === 404
			? 'The toolchain version this extension expects is not published at that URL. Did you mean to update the extension, or fix vscwclang.toolchainUrl?'
			: 'The host refused or failed the request; try again later.';
		return new Error(`${e.message} ${hint}`);
	}
	const msg = (e as Error).message ?? String(e);
	if (e instanceof TypeError) {
		// fetch() rejects with a bare TypeError for network failure, CORS and COEP blocks alike.
		return new Error(`could not reach ${host(url)} (${msg}). Check your internet connection; if you are online, the host may be blocking cross-origin requests (vscode.dev requires CORS and Cross-Origin-Resource-Policy headers). The toolchain is cached after the first successful download, so this only matters once.`);
	}
	return new Error(msg);
}

async function fetchOnce(url: string, expectedSize: number | undefined, opts: DownloadOptions, onBytes: (n: number) => void): Promise<Uint8Array<ArrayBuffer>> {
	const res = await (opts.fetch ?? fetch)(url, { mode: 'cors', signal: opts.signal });
	if (!res.ok) { throw new HttpStatusError(res.status, `HTTP ${res.status} ${res.statusText} for ${url}.`); }
	if (!res.body) {
		const all = new Uint8Array(await res.arrayBuffer());
		onBytes(all.byteLength);
		return all;
	}
	const reader = res.body.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		parts.push(value);
		length += value.byteLength;
		if (expectedSize !== undefined && length > expectedSize) {
			void reader.cancel();
			throw new Error(`${url} sent more than the ${mb(expectedSize)} the manifest lists; the host may be serving a different file.`);
		}
		onBytes(value.byteLength);
	}
	const out = new Uint8Array(length);
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.byteLength; }
	return out;
}
