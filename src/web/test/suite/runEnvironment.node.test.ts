import * as assert from 'assert';
import { defaultRunEnvironment, joinArgs, splitArgs } from '../../toolchain/runEnvironment';
import { artifactsBelongInFolder, artifactSubdir, storageKeyFor } from '../../toolchain/artifactPolicy';

suite('runEnvironment', () => {
	test('defaults set HOME, TMPDIR, USER and LANG', () => {
		assert.deepStrictEqual(defaultRunEnvironment(), { HOME: '/home/user', TMPDIR: '/tmp', USER: 'user', LANG: 'C.UTF-8' });
	});

	test('extra variables override or (when null) remove defaults', () => {
		const env = defaultRunEnvironment({ HOME: '/elsewhere', LANG: null, MODE: 'x' });
		assert.deepStrictEqual(env, { HOME: '/elsewhere', TMPDIR: '/tmp', USER: 'user', MODE: 'x' });
	});
});

suite('splitArgs', () => {
	test('splits on whitespace and handles quotes and escapes', () => {
		assert.deepStrictEqual(splitArgs('  a  b\tc '), ['a', 'b', 'c']);
		assert.deepStrictEqual(splitArgs(String.raw`"my file.txt" 'it'\''s' x\ y`), ['my file.txt', "it's", 'x y']);
		assert.deepStrictEqual(splitArgs(String.raw`"a \"q\" \\" ""`), ['a "q" \\', '']);
		assert.deepStrictEqual(splitArgs(''), []);
	});

	test('an unterminated quote is an error with a suggestion', () => {
		assert.throws(() => splitArgs('"abc'), /unterminated " .*Did you mean/);
	});

	test('joinArgs round-trips through splitArgs', () => {
		for (const args of [[], ['a'], ['my file', "it's", '', '$x', 'a"b'], ['/workspace/in.txt', '-n=5']]) {
			assert.deepStrictEqual(splitArgs(joinArgs(args)), args);
		}
	});
});

suite('artifactPolicy', () => {
	test('writable local and unknown schemes keep artifacts in the folder; read-only and virtual repos do not', () => {
		assert.strictEqual(artifactsBelongInFolder('file', true), true);
		assert.strictEqual(artifactsBelongInFolder('vscode-test-web', undefined), true);
		assert.strictEqual(artifactsBelongInFolder('file', false), false);
		assert.strictEqual(artifactsBelongInFolder('vscode-vfs', undefined), false);
		assert.strictEqual(artifactsBelongInFolder('github', true), false);
	});

	test('subdir is per mode, storage key is stable, safe and distinct per folder', () => {
		assert.strictEqual(artifactSubdir('debug'), '.vscwclang/debug');
		const a = storageKeyFor('vscode-vfs://github/Ambeco/repo');
		assert.strictEqual(a, storageKeyFor('vscode-vfs://github/Ambeco/repo/'));
		assert.notStrictEqual(a, storageKeyFor('vscode-vfs://github/Other/repo'));
		assert.match(a, /^repo-[0-9a-f]{8}$/);
	});
});
