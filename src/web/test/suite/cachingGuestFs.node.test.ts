import * as assert from 'assert';
import { CachingGuestFs } from '../../host/cachingGuestFs';
import type { GuestFileSystem } from '../../host/guestProcess';
import type { GuestDirEntry, GuestStat } from '../../host/wasiGuest';

class CountingFs implements GuestFileSystem {
	readonly files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
	reads = 0;
	stats = 0;
	async stat(path: string): Promise<GuestStat> {
		this.stats++;
		const f = this.files.get(path);
		if (!f) { throw Object.assign(new Error(`no such file ${path}`), { code: 'ENOENT' }); }
		return { type: 'file', size: f.bytes.length, mtimeMs: f.mtimeMs };
	}
	async readFile(path: string): Promise<Uint8Array> {
		this.reads++;
		await Promise.resolve();
		const f = this.files.get(path);
		if (!f) { throw Object.assign(new Error(`no such file ${path}`), { code: 'ENOENT' }); }
		return f.bytes;
	}
	async writeFile(path: string, data: Uint8Array): Promise<void> { this.files.set(path, { bytes: data, mtimeMs: Date.now() }); }
	async readDirectory(): Promise<GuestDirEntry[]> { return []; }
	async createDirectory(): Promise<void> { /* none */ }
	async delete(path: string): Promise<void> { for (const k of [...this.files.keys()]) { if (k === path || k.startsWith(`${path}/`)) { this.files.delete(k); } } }
	async rename(from: string, to: string): Promise<void> { const f = this.files.get(from); if (f) { this.files.set(to, f); this.files.delete(from); } }
}

const bytes = (...v: number[]) => new Uint8Array(v);

async function open(fs: GuestFileSystem, path: string): Promise<Uint8Array> {
	await fs.stat(path);
	return fs.readFile(path);
}

suite('CachingGuestFs', () => {
	let inner: CountingFs;
	let fs: CachingGuestFs;
	setup(() => {
		inner = new CountingFs();
		inner.files.set('/a.h', { bytes: bytes(1, 2, 3), mtimeMs: 100 });
		fs = new CachingGuestFs(inner);
	});

	test('a second open of an unchanged file does not read it again', async () => {
		assert.deepStrictEqual([...await open(fs, '/a.h')], [1, 2, 3]);
		assert.deepStrictEqual([...await open(fs, '/a.h')], [1, 2, 3]);
		assert.deepStrictEqual([inner.reads, fs.hits, fs.misses], [1, 1, 1]);
	});

	test('threads opening the same file at once share one read', async () => {
		const all = await Promise.all([1, 2, 3, 4].map(() => open(fs, '/a.h')));
		assert.strictEqual(inner.reads, 1);
		all.forEach(a => assert.deepStrictEqual([...a], [1, 2, 3]));
	});

	test('a changed mtime or size seen by stat drops the cached bytes', async () => {
		await open(fs, '/a.h');
		inner.files.set('/a.h', { bytes: bytes(9, 9, 9), mtimeMs: 200 });
		assert.deepStrictEqual([...await open(fs, '/a.h')], [9, 9, 9]);
		inner.files.set('/a.h', { bytes: bytes(7, 7), mtimeMs: 200 });
		assert.deepStrictEqual([...await open(fs, '/a.h')], [7, 7]);
		assert.strictEqual(inner.reads, 3);
	});

	test('writes, deletes and renames through the wrapper drop the path (and a deleted folder\'s children)', async () => {
		await open(fs, '/a.h');
		await fs.writeFile('/a.h', bytes(5));
		assert.deepStrictEqual([...await open(fs, '/a.h')], [5]);
		inner.files.set('/d/x.h', { bytes: bytes(1), mtimeMs: 5 });
		await open(fs, '/d/x.h');
		await fs.delete('/d');
		await assert.rejects(open(fs, '/d/x.h'), /no such file/);
		await fs.rename('/a.h', '/b.h');
		await assert.rejects(open(fs, '/a.h'), /no such file/);
		assert.deepStrictEqual([...await open(fs, '/b.h')], [5]);
	});

	test('a file with no mtime is never cached, since nothing could show it changed', async () => {
		inner.files.set('/n.h', { bytes: bytes(1), mtimeMs: 0 });
		await open(fs, '/n.h');
		await open(fs, '/n.h');
		assert.strictEqual(inner.reads, 2);
	});

	test('a read with no stat before it, and a failed read, are not cached', async () => {
		await fs.readFile('/a.h');
		await fs.readFile('/a.h');
		assert.strictEqual(inner.reads, 2);
		await assert.rejects(open(fs, '/missing.h'));
		inner.files.set('/missing.h', { bytes: bytes(4), mtimeMs: 1 });
		assert.deepStrictEqual([...await open(fs, '/missing.h')], [4]);
	});

	test('the least recently read file is evicted past the byte budget, and big files are not cached', async () => {
		const small = new CachingGuestFs(inner, 5, 4);
		for (const [name, n] of [['/p', 3], ['/q', 3], ['/big', 6]] as const) { inner.files.set(name, { bytes: new Uint8Array(n), mtimeMs: 1 }); }
		await open(small, '/p');
		await open(small, '/q');
		await open(small, '/big');
		await open(small, '/big');
		await open(small, '/q');
		await open(small, '/p');
		assert.deepStrictEqual([inner.reads], [5]); // p, q, big, big (never cached), p again after eviction; q was a hit
	});
});
