import * as assert from 'assert';
import { zipSync } from 'fflate';
import { getFile, missingBytes, parseManifest, ProgressTracker, resolveManifest, sha256Hex, type ByteStore, type ManifestFile, type ToolchainManifest } from '../../toolchain/toolchainDownload';

const enc = new TextEncoder();
const bytesOf = (text: string) => enc.encode(text) as Uint8Array<ArrayBuffer>;

class MemStore implements ByteStore {
	files = new Map<string, Uint8Array<ArrayBuffer>>();
	async size(name: string) { return this.files.get(name)?.byteLength; }
	async read(name: string) { return this.files.get(name)!; }
	async write(name: string, bytes: Uint8Array) { this.files.set(name, new Uint8Array(bytes)); }
	async delete(name: string) { this.files.delete(name); }
}

type Served = Map<string, Uint8Array<ArrayBuffer> | (() => Response | Promise<Response>)>;

function fakeFetch(served: Served, log: string[] = []): typeof fetch {
	return (async (input: string) => {
		log.push(input);
		const hit = served.get(input);
		if (hit === undefined) { return new Response('not found', { status: 404, statusText: 'Not Found' }); }
		return typeof hit === 'function' ? hit() : new Response(hit);
	}) as unknown as typeof fetch;
}

async function publish(content: Uint8Array<ArrayBuffer>, name: string, kind: 'raw' | 'zip', chunkSize: number, served: Served): Promise<ManifestFile> {
	const payload = kind === 'zip' ? zipSync({ [name]: content }) : content;
	const chunks = [];
	for (let i = 0, n = 0; i < payload.length; i += chunkSize, n++) {
		const part = new Uint8Array(payload.subarray(i, i + chunkSize));
		const chunkName = `${name}.${n}`;
		served.set(`https://host/tc/${chunkName}`, part);
		chunks.push({ name: chunkName, size: part.length, sha256: await sha256Hex(part) });
	}
	return { size: content.length, sha256: await sha256Hex(content), payloadKind: kind, chunks };
}

const manifestOf = (files: Record<string, ManifestFile>): ToolchainManifest => ({ format: 1, tag: 'v-test', files });
const OPTS = { baseUrl: 'https://host/tc/', retryDelayMs: 1 };

suite('toolchain download', () => {
	const content = bytesOf('0123456789abcdefghijklmnopqrstuvwxyz'.repeat(5));

	test('multi-chunk raw file is downloaded, verified and cached; the second call does not fetch', async () => {
		const served: Served = new Map(); const log: string[] = [];
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 50, served) });
		const store = new MemStore();
		assert.deepStrictEqual(await getFile(manifest, store, 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served, log) }), content);
		assert.strictEqual(log.length, 4);
		assert.ok(store.files.has('k/a.bin'));
		log.length = 0;
		assert.deepStrictEqual(await getFile(manifest, store, 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served, log) }), content);
		assert.deepStrictEqual(log, []);
	});

	test('zip payload is unzipped to the named entry', async () => {
		const served: Served = new Map();
		const manifest = manifestOf({ 'tool.wasm': await publish(content, 'tool.wasm', 'zip', 64, served) });
		assert.deepStrictEqual(await getFile(manifest, new MemStore(), 'k', 'tool.wasm', { ...OPTS, fetch: fakeFetch(served) }), content);
	});

	test('a corrupt chunk fails after retries and caches nothing', async () => {
		const served: Served = new Map(); const log: string[] = [];
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 100, served) });
		served.set('https://host/tc/a.bin.1', bytesOf('x'.repeat(manifest.files['a.bin'].chunks[1].size)));
		const store = new MemStore();
		await assert.rejects(getFile(manifest, store, 'k', 'a.bin', { ...OPTS, retries: 2, fetch: fakeFetch(served, log) }), /a\.bin\.1: SHA-256 mismatch/);
		assert.strictEqual(log.filter(u => u.endsWith('a.bin.1')).length, 3);
		assert.strictEqual(store.files.size, 0);
	});

	test('a transient 500 is retried', async () => {
		const served: Served = new Map();
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 1000, served) });
		const good = served.get('https://host/tc/a.bin.0') as Uint8Array<ArrayBuffer>;
		let calls = 0;
		served.set('https://host/tc/a.bin.0', () => ++calls === 1 ? new Response('boom', { status: 500, statusText: 'Server Error' }) : new Response(good));
		assert.deepStrictEqual(await getFile(manifest, new MemStore(), 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served) }), content);
		assert.strictEqual(calls, 2);
	});

	test('404 is not retried and suggests updating the extension', async () => {
		const served: Served = new Map(); const log: string[] = [];
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 1000, served) });
		served.delete('https://host/tc/a.bin.0');
		await assert.rejects(getFile(manifest, new MemStore(), 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served, log) }), /404[\s\S]*update the extension/);
		assert.strictEqual(log.length, 1);
	});

	test('a network failure explains CORS and offline', async () => {
		const served: Served = new Map();
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 1000, served) });
		const failing = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
		await assert.rejects(getFile(manifest, new MemStore(), 'k', 'a.bin', { ...OPTS, retries: 0, fetch: failing }), /could not reach host[\s\S]*internet connection[\s\S]*CORS/);
	});

	test('a cached file with the right size but wrong bytes is replaced', async () => {
		const served: Served = new Map(); const log: string[] = [];
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 1000, served) });
		const store = new MemStore();
		store.files.set('k/a.bin', new Uint8Array(content.length));
		assert.deepStrictEqual(await getFile(manifest, store, 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served, log) }), content);
		assert.deepStrictEqual(store.files.get('k/a.bin'), content);
		assert.strictEqual(log.length, 1);
	});

	test('a final hash mismatch (manifest from another build) is rejected and not cached', async () => {
		const served: Served = new Map();
		const entry = await publish(content, 'a.bin', 'raw', 1000, served);
		const store = new MemStore();
		await assert.rejects(getFile(manifestOf({ 'a.bin': { ...entry, sha256: '0'.repeat(64) } }), store, 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served) }), /SHA-256 mismatch[\s\S]*not cached/);
		assert.strictEqual(store.files.size, 0);
	});

	test('unknown file name lists what the toolchain has', async () => {
		const manifest = manifestOf({ 'a.bin': { size: 1, sha256: 'x', payloadKind: 'raw', chunks: [{ name: 'c', size: 1, sha256: 'x' }] } });
		await assert.rejects(getFile(manifest, new MemStore(), 'k', 'b.bin', OPTS), /no file 'b\.bin'[\s\S]*a\.bin/);
	});

	test('progress ends at the total, and a failed attempt is taken back', async () => {
		const served: Served = new Map();
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 60, served) });
		const total = await missingBytes(manifest, new MemStore(), 'k', ['a.bin']);
		assert.strictEqual(total, content.length);
		const good = served.get('https://host/tc/a.bin.0') as Uint8Array<ArrayBuffer>;
		let calls = 0;
		served.set('https://host/tc/a.bin.0', () => ++calls === 1 ? new Response('x'.repeat(good.length)) : new Response(good));
		const seen: number[] = [];
		await getFile(manifest, new MemStore(), 'k', 'a.bin', { ...OPTS, fetch: fakeFetch(served) }, new ProgressTracker({ onProgress: (d, t) => { seen.push(d); assert.strictEqual(t, total); } }, total));
		assert.strictEqual(seen[seen.length - 1], total);
		assert.ok(Math.max(...seen) <= total, 'rolled-back bytes must not be double counted');
	});

	test('cancelling reports that downloaded files are kept', async () => {
		const served: Served = new Map();
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 1000, served) });
		const abort = new AbortController();
		const aborting = (async () => { abort.abort(); throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
		await assert.rejects(getFile(manifest, new MemStore(), 'k', 'a.bin', { ...OPTS, signal: abort.signal, fetch: aborting }), /cancelled[\s\S]*resumes/);
	});

	test('missingBytes counts only files not cached at the right size', async () => {
		const served: Served = new Map();
		const manifest = manifestOf({ 'a.bin': await publish(content, 'a.bin', 'raw', 50, served), 'b.bin': await publish(bytesOf('hello'), 'b.bin', 'raw', 50, served) });
		const store = new MemStore();
		store.files.set('k/b.bin', bytesOf('hello'));
		assert.strictEqual(await missingBytes(manifest, store, 'k', ['a.bin', 'b.bin']), content.length);
	});
});

suite('toolchain manifest', () => {
	const manifestJson = JSON.stringify(manifestOf({ 'a.bin': { size: 1, sha256: 'x', payloadKind: 'raw', chunks: [{ name: 'c', size: 1, sha256: 'x' }] } }));

	test('parseManifest rejects HTML, wrong formats and malformed entries with hints', () => {
		assert.throws(() => parseManifest('<html>404</html>'), /not valid JSON[\s\S]*HTML/);
		assert.throws(() => parseManifest('{"format":2,"tag":"t","files":{}}'), /format 1[\s\S]*update the extension/);
		assert.throws(() => parseManifest('{"format":1,"tag":"t","files":{"a":{"size":1}}}'), /entry 'a' is malformed/);
		assert.strictEqual(parseManifest(manifestJson).tag, 'v-test');
	});

	test('a pinned manifest must hash to the pin', async () => {
		const served: Served = new Map([['https://host/tc/manifest.json', bytesOf(manifestJson)]]);
		const sha = await sha256Hex(bytesOf(manifestJson));
		const store = new MemStore();
		assert.strictEqual((await resolveManifest(store, { ...OPTS, fetch: fakeFetch(served) }, sha)).sha256, sha);
		await assert.rejects(resolveManifest(new MemStore(), { ...OPTS, fetch: fakeFetch(served) }, '1'.repeat(64)), /pins 1{64}[\s\S]*update the extension/);
	});

	test('a pinned manifest is served from cache without network', async () => {
		const sha = await sha256Hex(bytesOf(manifestJson));
		const store = new MemStore();
		store.files.set(`manifest-${sha}.json`, bytesOf(manifestJson));
		const log: string[] = [];
		await resolveManifest(store, { ...OPTS, fetch: fakeFetch(new Map(), log) }, sha);
		assert.deepStrictEqual(log, []);
	});

	test('a corrupt cached manifest is refetched', async () => {
		const sha = await sha256Hex(bytesOf(manifestJson));
		const store = new MemStore();
		store.files.set(`manifest-${sha}.json`, bytesOf('{"corrupt":true}'));
		const served: Served = new Map([['https://host/tc/manifest.json', bytesOf(manifestJson)]]);
		await resolveManifest(store, { ...OPTS, fetch: fakeFetch(served) }, sha);
		assert.deepStrictEqual(store.files.get(`manifest-${sha}.json`), bytesOf(manifestJson));
	});

	test('without a pin the manifest is fetched and cached under its own hash', async () => {
		const served: Served = new Map([['https://host/tc/manifest.json', bytesOf(manifestJson)]]);
		const store = new MemStore();
		const { sha256 } = await resolveManifest(store, { ...OPTS, fetch: fakeFetch(served) }, undefined);
		assert.ok(store.files.has(`manifest-${sha256}.json`));
	});
});
