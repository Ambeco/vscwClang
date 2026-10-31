import * as assert from 'assert';
import { OVERLAY_BATCH_SIZE, batches, clangdArgs, clangdThreadCount, compilationDatabaseChanges, shardMountPoint } from '../../clangd/clangdConfig';

suite('clangdConfig', () => {
	test('clangdThreadCount leaves a core for the extension host and stays within 2..4', () => {
		assert.strictEqual(clangdThreadCount(undefined), 3);
		assert.strictEqual(clangdThreadCount(1), 2);
		assert.strictEqual(clangdThreadCount(4), 3);
		assert.strictEqual(clangdThreadCount(64), 4);
	});

	test('clangdArgs turns the real background indexer on and never uses single-threaded -sync', () => {
		const args = clangdArgs('error', 3);
		assert.deepStrictEqual(args, ['-background-index', '-j=3', '-resource-dir=/resource', '-log=error']);
		assert.ok(!args.includes('-sync'));
	});

	test('compilationDatabaseChanges: one command per file, clang for .c and clang++ otherwise', () => {
		const changes = compilationDatabaseChanges(['/workspace/a.cpp', '/workspace/src/b.cc', '/workspace/c.c'], ['--target=wasm32-wasip1', '-std=c++20']);
		assert.deepStrictEqual(Object.keys(changes), ['/workspace/a.cpp', '/workspace/src/b.cc', '/workspace/c.c']);
		assert.deepStrictEqual(changes['/workspace/a.cpp'], { workingDirectory: '/workspace', compilationCommand: ['clang++', '--target=wasm32-wasip1', '-std=c++20', '/workspace/a.cpp'] });
		assert.strictEqual(changes['/workspace/src/b.cc'].compilationCommand[0], 'clang++');
		assert.strictEqual(changes['/workspace/c.c'].compilationCommand[0], 'clang');
	});

	test('shardMountPoint is <root>/.cache/clangd under the database directory, and undefined outside the workspace', () => {
		assert.strictEqual(shardMountPoint(''), '/workspace/.cache/clangd');
		assert.strictEqual(shardMountPoint('build'), '/workspace/build/.cache/clangd');
		assert.strictEqual(shardMountPoint('./out/debug/'), '/workspace/out/debug/.cache/clangd');
		assert.strictEqual(shardMountPoint('/abs/dir'), undefined);
		assert.strictEqual(shardMountPoint('../elsewhere'), undefined);
	});

	test('batches splits into slices of at most OVERLAY_BATCH_SIZE', () => {
		assert.deepStrictEqual(batches([], 2), []);
		assert.deepStrictEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
		assert.strictEqual(batches(Array.from({ length: OVERLAY_BATCH_SIZE * 2 + 1 }, (_, i) => i), OVERLAY_BATCH_SIZE).length, 3);
	});
});
