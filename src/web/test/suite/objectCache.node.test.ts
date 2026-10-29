import * as assert from 'assert';
import { ObjectCache, splitIncludeTrace } from '../../toolchain/objectCache';

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
	setup(() => { files.clear(); files.set('/workspace/a.h', 'v1'); });

	test('hits while args, source and headers are unchanged', async () => {
		const c = new ObjectCache();
		await c.store('k', 'args', 'src', ['/workspace/a.h'], obj, 'warn', read);
		const hit = await c.lookup('k', 'args', 'src', read);
		assert.strictEqual(hit?.stderr, 'warn');
		assert.strictEqual(hit?.object, obj);
	});

	test('misses when the source, the args or a header changes, or a header vanishes', async () => {
		const c = new ObjectCache();
		await c.store('k', 'args', 'src', ['/workspace/a.h'], obj, '', read);
		assert.strictEqual(await c.lookup('k', 'args', 'src2', read), undefined);
		assert.strictEqual(await c.lookup('k', 'args2', 'src', read), undefined);
		assert.strictEqual(await c.lookup('other', 'args', 'src', read), undefined);
		files.set('/workspace/a.h', 'v2');
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
		files.delete('/workspace/a.h');
		assert.strictEqual(await c.lookup('k', 'args', 'src', read), undefined);
	});

	test('store gives each object a fresh id and replaces the old entry', async () => {
		const c = new ObjectCache();
		const a = await c.store('k', 'args', 'src', [], obj, '', read);
		const b = await c.store('k', 'args', 'src', [], obj, '', read);
		assert.notStrictEqual(a!.id, b!.id);
		assert.strictEqual(c.size, 1);
	});

	test('is not stored when a header cannot be read', async () => {
		const c = new ObjectCache();
		assert.strictEqual(await c.store('k', 'args', 'src', ['/workspace/missing.h'], obj, '', read), undefined);
		assert.strictEqual(c.size, 0);
	});

	test('evicts least recently used past the size cap', async () => {
		const c = new ObjectCache(20);
		await c.store('a', 'x', 's', [], new Uint8Array(10), '', read);
		await c.store('b', 'x', 's', [], new Uint8Array(10), '', read);
		await c.lookup('a', 'x', 's', read);
		await c.store('c', 'x', 's', [], new Uint8Array(10), '', read);
		assert.ok(await c.lookup('a', 'x', 's', read));
		assert.strictEqual(await c.lookup('b', 'x', 's', read), undefined);
		assert.ok(await c.lookup('c', 'x', 's', read));
	});
});
