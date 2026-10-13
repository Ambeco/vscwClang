import * as assert from 'assert';
import { DEFAULT_EXCLUDE, makeSourceExcluder } from '../../toolchain/sourceFilter';

suite('makeSourceExcluder', () => {
	const defaults = makeSourceExcluder(DEFAULT_EXCLUDE);

	test('ordinary sources are kept', () => {
		assert.strictEqual(defaults('main.cpp'), false);
		assert.strictEqual(defaults('algorithms/sort.cpp'), false);
	});

	test('Visual Studio scratch and build folders are skipped, at any depth', () => {
		for (const p of ['enc_temp_folder/97a0c4f1/main.cpp', 'x64/Debug/gen.cpp', 'Debug/a.cpp', 'sub/.vs/x.cpp', 'a/Release/b.cpp']) {
			assert.strictEqual(defaults(p), true, p);
		}
	});

	test('matching ignores case and both slash styles, and a leading slash', () => {
		const backslash = String.fromCharCode(92);
		assert.strictEqual(defaults(['ENC_TEMP_FOLDER', 'x', 'main.cpp'].join(backslash)), true);
		assert.strictEqual(defaults('/build/a.cpp'), true);
	});

	test('only whole names match, never a substring', () => {
		assert.strictEqual(defaults('Debug.cpp'), false);
		assert.strictEqual(defaults('debugging/a.cpp'), false);
	});

	test('the object is configurable, and false or non-boolean values do not exclude', () => {
		assert.strictEqual(makeSourceExcluder({ '**/tests': true })('tests/main.cpp'), true);
		assert.strictEqual(makeSourceExcluder({ '**/tests': true })('build/a.cpp'), false);
		assert.strictEqual(makeSourceExcluder({ '**/tests': false })('tests/main.cpp'), false);
		assert.strictEqual(makeSourceExcluder({ '**/*.cpp': { when: '$(basename).h' } })('a.cpp'), false);
	});

	test('a pattern without ** is anchored at the workspace folder', () => {
		const top = makeSourceExcluder({ build: true });
		assert.strictEqual(top('build/a.cpp'), true);
		assert.strictEqual(top('src/build/a.cpp'), false);
	});

	test('wildcards, ? and braces', () => {
		const x = makeSourceExcluder({ '**/*.gen.cpp': true, 'third_party/**': true, '**/{legacy,old}_?': true, 'a/*/c.cpp': true });
		assert.strictEqual(x('src/foo.gen.cpp'), true);
		assert.strictEqual(x('foo.cpp'), false);
		assert.strictEqual(x('third_party/zlib/z.c'), true);
		assert.strictEqual(x('x/legacy_1/z.c'), true);
		assert.strictEqual(x('x/old_22/z.c'), false);
		assert.strictEqual(x('a/b/c.cpp'), true);
		assert.strictEqual(x('a/b/d/c.cpp'), false);
	});

	test('files are matched too, and regex characters in globs are literal', () => {
		assert.strictEqual(makeSourceExcluder({ '**/gen.cpp': true })('src/gen.cpp'), true);
		assert.strictEqual(makeSourceExcluder({ '**/a+b.cpp': true })('aab.cpp'), false);
		assert.strictEqual(makeSourceExcluder({ '**/a+b.cpp': true })('x/a+b.cpp'), true);
	});

	test('a leading workspace variable is accepted in globs', () => {
		assert.strictEqual(makeSourceExcluder({ '${workspaceFolder}/gen/**': true })('gen/a.cpp'), true);
		assert.strictEqual(makeSourceExcluder({ '${workspaceFolder}/gen/**': true })('src/gen/a.cpp'), false);
	});

	test('empty object and unbalanced braces do not throw', () => {
		assert.strictEqual(makeSourceExcluder({})('a.cpp'), false);
		assert.doesNotThrow(() => makeSourceExcluder({ '**/{a,b': true })('x'));
	});
});
