import * as assert from 'assert';
import { MemoryByteStore, ObjectCache, splitIncludeTrace } from '../../toolchain/objectCache';

const enc = (s: string) => new Uint8Array(new TextEncoder().encode(s));

suite('splitIncludeTrace', () => {
	test('keeps workspace headers, drops toolchain ones and the -H lines', () => {
		const stderr = ['. /workspace/a.h', '.. /workspace/sub/b.h', '. /sysroot/include/c++/v1/vector', '/workspace/x.cpp:1:1: warning: w', ''].join('\n');
		const r = splitIncludeTrace(stderr, '/workspace');
		assert.deepStrictEqual(r.headers.sort(), ['/workspace/a.h', '/workspace/sub/b.h']);
		assert.strictEqual(r.stderr, '/workspace/x.cpp:1:1: warning: w\n');
	});

	test('drops the multiple-include-guard trailer', () => {
		const r = splitIncludeTrace(['. /workspace/a.h', 'Multiple include guards may be useful for:', '/workspace/a.h', ''].join('\n'), '/workspace');
		assert.strictEqual(r.stderr, '');
	});

	test('does not match lookalike folders', () => {
		assert.deepStrictEqual(splitIncludeTrace('. /workspace2/a.h\n', '/workspace').headers, []);
	});
});

suite('ObjectCache', () => {
	const files = new Map<string, string>();
	const read = async (p: string) => files.has(p) ? enc(files.get(p)!) : undefined;
	const obj = enc('object');
	const objKeys = async (store: MemoryByteStore) => (await store.keys()).filter(k => k.startsWith('obj/'));
	let clock = 1000;
	const now = () => clock;
	let store: MemoryByteStore;
	setup(() => { files.clear(); files.set('/workspace/a.h', 'v1'); clock = 1000; store = new MemoryByteStore(); });

	test('hits while args, source and headers are unchanged, and replays the warnings', async () => {
		const c = new ObjectCache(store);
		await c.store('k', 'args', 'src', ['/workspace/a.h'], obj, 'warn', read);
		const hit = await c.lookup('k', 'args', 'src', read);
		assert.strictEqual(hit?.stderr, 'warn');
		assert.deepStrictEqual(hit?.object, obj);
	});

	test('misses when the source, the args or a header changes, or a header vanishes', async () => {
		const c = new ObjectCache(store);
		await c.store('k', 'args', 'src', ['/workspace/a.h'], obj, '', read);
		assert.strictEqual(await c.lookup('k', 'args', 'src2', read), undefined);
		assert.strictEqual(await c.lookup('k', 'args2', 'src', read), undefined);
		assert.strictEqual(await c.lookup('other', 'args', 'src', read), undefined);
		files.set('/workspace/a.h', 'v2');
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
		files.delete('/workspace/a.h');
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
	});

	test('with several headers, a change in any one (even the last) is a miss', async () => {
		const c = new ObjectCache(store);
		const headers = ['/workspace/a.h', '/workspace/b.h', '/workspace/c.h'];
		files.set('/workspace/b.h', 'b1'); files.set('/workspace/c.h', 'c1');
		await c.store('k', 'args', 'src', headers, obj, '', read);
		assert.ok(await c.lookup('k', 'args', 'src', read));
		files.set('/workspace/c.h', 'c2');
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
	});

	test('the id is the content hash: equal objects share it, different ones do not', async () => {
		const c = new ObjectCache(store);
		const a = await c.store('a', 'x', 's', [], obj, '', read);
		const b = await c.store('b', 'x', 's', [], obj, '', read);
		const d = await c.store('d', 'x', 's', [], enc('other'), '', read);
		assert.strictEqual(a!.id, b!.id);
		assert.notStrictEqual(a!.id, d!.id);
	});

	test('is not stored when a header cannot be read or the store refuses', async () => {
		const c = new ObjectCache(store);
		assert.strictEqual(await c.store('k', 'args', 'src', ['/workspace/missing.h'], obj, '', read), undefined);
		const refusing = Object.assign(new MemoryByteStore(), { put: async () => { throw new Error('quota'); } });
		const full = new ObjectCache(refusing);
		assert.strictEqual(await full.store('k', 'args', 'src', [], obj, '', read), undefined);
		assert.strictEqual((await full.stats()).entries, 0);
	});

	test('survives a restart: a new cache over the same store sees flushed entries', async () => {
		const c = new ObjectCache(store, { now });
		await c.store('k', 'args', 'src', ['/workspace/a.h'], obj, 'w', read);
		await c.flush();
		const hit = await new ObjectCache(store, { now }).lookup('k', 'args', 'src', read);
		assert.deepStrictEqual([hit?.stderr, hit?.object], ['w', obj]);
	});

	test('a build that dies midway keeps what it finished: store saves the index every saveIntervalMs, without flush', async () => {
		const c = new ObjectCache(store, { now, saveIntervalMs: 100 });
		await c.store('a', 'x', 's', [], enc('o1'), '', read);
		clock += 150;
		await c.store('b', 'x', 's', [], enc('o2'), '', read);
		clock += 10;
		await c.store('lost', 'x', 's', [], enc('o3'), '', read);
		const reopened = new ObjectCache(store, { now });
		assert.ok(await reopened.lookup('a', 'x', 's', read));
		assert.ok(await reopened.lookup('b', 'x', 's', read));
		assert.strictEqual(await reopened.lookup('lost', 'x', 's', read), undefined);
	});

	test('entries not flushed are lost on restart', async () => {
		await new ObjectCache(store, { now }).store('k', 'args', 'src', [], obj, '', read);
		assert.strictEqual(await new ObjectCache(store, { now }).lookup('k', 'args', 'src', read), undefined);
	});

	test('a corrupt index is an empty cache and its objects are swept', async () => {
		const c = new ObjectCache(store, { now });
		await c.store('k', 'args', 'src', [], obj, '', read);
		await c.flush();
		await store.put('index', enc('{not json'));
		const reopened = new ObjectCache(store, { now });
		assert.strictEqual(await reopened.lookup('k', 'args', 'src', read), undefined);
		await reopened.flush();
		assert.deepStrictEqual(await objKeys(store), []);
	});

	test('an index entry whose object vanished is a miss and is forgotten', async () => {
		const c = new ObjectCache(store, { now });
		await c.store('k', 'args', 'src', [], obj, '', read);
		await c.flush();
		for (const k of await objKeys(store)) { await store.delete(k); }
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
		assert.strictEqual((await c.stats()).entries, 0);
	});

	test('entries unused for longer than the max age are dropped with their objects', async () => {
		const c = new ObjectCache(store, { now, maxAgeMs: 100 });
		await c.store('old', 'x', 's', [], enc('o1'), '', read);
		await c.store('used', 'x', 's', [], enc('o2'), '', read);
		clock += 80;
		assert.ok(await c.lookup('used', 'x', 's', read));
		clock += 50;
		await c.flush();
		assert.strictEqual((await c.stats()).entries, 1);
		assert.ok(await c.lookup('used', 'x', 's', read));
		assert.strictEqual(await c.lookup('old', 'x', 's', read), undefined);
		assert.strictEqual((await objKeys(store)).length, 1);
	});

	test('past the size cap the least recently used go first, and their objects are deleted', async () => {
		const c = new ObjectCache(store, { now, maxBytes: 20 });
		const o = (n: number) => new Uint8Array(10).fill(n);
		await c.store('a', 'x', 's', [], o(1), '', read);
		clock++;
		await c.store('b', 'x', 's', [], o(2), '', read);
		clock++;
		await c.lookup('a', 'x', 's', read);
		clock++;
		await c.store('c', 'x', 's', [], o(3), '', read);
		await c.flush();
		assert.ok(await c.lookup('a', 'x', 's', read));
		assert.strictEqual(await c.lookup('b', 'x', 's', read), undefined);
		assert.ok(await c.lookup('c', 'x', 's', read));
		assert.strictEqual((await objKeys(store)).length, 2);
	});

	test('clear empties the cache and the store', async () => {
		const c = new ObjectCache(store, { now });
		await c.store('k', 'args', 'src', [], obj, '', read);
		await c.flush();
		await c.clear();
		assert.deepStrictEqual(await c.stats(), { entries: 0, objects: 0, bytes: 0 });
		assert.deepStrictEqual(await store.keys(), []);
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
	});
});
