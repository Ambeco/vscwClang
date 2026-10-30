import * as assert from 'assert';
import { CacheStorageByteStore, ObjectCache } from '../../toolchain/objectCache';

// Probe: is the Cache API usable from the extension host, and how does it behave with object-sized blobs?
suite('CacheStorage probe (in browser)', function () {
	this.timeout(60_000);
	const NAME = 'vscwclang-probe';
	teardown(async () => { await caches.delete(NAME); });

	test('caches exists in the extension host and round-trips binary bytes', async () => {
		assert.strictEqual(typeof caches, 'object', 'no CacheStorage in this context');
		const cache = await caches.open(NAME);
		const bytes = new Uint8Array(1 << 20).map((_, i) => i * 31 & 255);
		await cache.put('https://vscwclang.invalid/obj/abc', new Response(bytes));
		const back = new Uint8Array(await (await cache.match('https://vscwclang.invalid/obj/abc'))!.arrayBuffer());
		assert.deepStrictEqual(back, bytes);
		assert.strictEqual(await cache.match('https://vscwclang.invalid/obj/missing'), undefined);
	});

	test('ObjectCache over CacheStorageByteStore survives a new instance, and clear() deletes the cache', async () => {
		const read = async () => undefined;
		const object = new Uint8Array([1, 2, 3, 4]);
		const first = new ObjectCache(new CacheStorageByteStore(NAME));
		assert.ok(await first.store('k', 'args', 'src', [], object, 'w', read));
		await first.flush();
		const second = new ObjectCache(new CacheStorageByteStore(NAME));
		const hit = await second.lookup('k', 'args', 'src', read);
		assert.deepStrictEqual([hit?.stderr, hit?.object], ['w', object]);
		assert.strictEqual((await second.stats()).objects, 1);
		await second.clear();
		assert.strictEqual(await caches.has(NAME), false);
	});

	test('timing and quota for 64 objects of 2 MB', async () => {
		const cache = await caches.open(NAME);
		const blob = new Uint8Array(2 << 20).map((_, i) => i & 255);
		let t = Date.now();
		for (let i = 0; i < 64; i++) { await cache.put(`https://vscwclang.invalid/obj/${i}`, new Response(blob)); }
		const put = Date.now() - t;
		t = Date.now();
		for (let i = 0; i < 64; i++) { await (await cache.match(`https://vscwclang.invalid/obj/${i}`))!.arrayBuffer(); }
		const get = Date.now() - t;
		const est = await navigator.storage?.estimate?.();
		console.log(`[cache probe] 128 MB: put ${put} ms, get ${get} ms; quota ${((est?.quota ?? 0) / 1048576).toFixed(0)} MB, usage ${((est?.usage ?? 0) / 1048576).toFixed(0)} MB; persisted=${await navigator.storage?.persisted?.()}`);
		assert.ok(await cache.delete('https://vscwclang.invalid/obj/0'));
		assert.strictEqual(await cache.match('https://vscwclang.invalid/obj/0'), undefined);
	});
});
