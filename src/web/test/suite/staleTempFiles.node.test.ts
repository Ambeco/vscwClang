import * as assert from 'assert';
import { removeStaleTempFiles, type TempDirFs } from '../../clangd/staleTempFiles';

function fakeFs(files: Record<string, number>, options: { failStat?: string; failDelete?: string; noDir?: boolean } = {}) {
	const deleted: string[] = [];
	const fs: TempDirFs<string> = {
		readDirectory: async () => { if (options.noDir) { throw new Error('ENOENT'); } return Object.keys(files).map(n => [n, 1] as [string, number]); },
		stat: async f => { if (f === `/tmp/${options.failStat}`) { throw new Error('gone'); } return { mtime: files[f.slice(5)] }; },
		delete: async f => { if (f === `/tmp/${options.failDelete}`) { throw new Error('busy'); } deleted.push(f.slice(5)); },
		child: (dir, name) => `${dir}/${name}`,
	};
	return { fs, deleted };
}

suite('removeStaleTempFiles', () => {
	const now = 1_000_000;

	test('deletes only files older than the age limit', async () => {
		const { fs, deleted } = fakeFs({ 'preamble-old.pch': now - 3_600_000, 'preamble-new.pch': now - 1_000, 'preamble-edge.pch': now - 600_000 });
		assert.strictEqual(await removeStaleTempFiles(fs, '/tmp', now, 600_000), 2);
		assert.deepStrictEqual(deleted.sort(), ['preamble-edge.pch', 'preamble-old.pch']);
	});

	test('handles more files than one batch', async () => {
		const files: Record<string, number> = {};
		for (let i = 0; i < 50; i++) { files[`p${i}.pch`] = i % 2 === 0 ? 0 : now; }
		const { fs, deleted } = fakeFs(files);
		assert.strictEqual(await removeStaleTempFiles(fs, '/tmp', now, 1000), 25);
		assert.strictEqual(deleted.length, 25);
	});

	test('a file that vanishes or cannot be deleted is skipped, not fatal', async () => {
		const { fs, deleted } = fakeFs({ a: 0, b: 0, c: 0 }, { failStat: 'a', failDelete: 'b' });
		assert.strictEqual(await removeStaleTempFiles(fs, '/tmp', now, 1000), 1);
		assert.deepStrictEqual(deleted, ['c']);
	});

	test('a missing folder is not an error', async () => {
		const { fs } = fakeFs({}, { noDir: true });
		assert.strictEqual(await removeStaleTempFiles(fs, '/tmp', now, 1000), 0);
	});
});
