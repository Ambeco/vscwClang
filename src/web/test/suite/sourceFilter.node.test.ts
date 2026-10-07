import * as assert from 'assert';
import { DEFAULT_EXCLUDED_DIRS, isExcludedSource } from '../../toolchain/sourceFilter';

suite('isExcludedSource', () => {
	test('ordinary sources are kept', () => {
		assert.strictEqual(isExcludedSource('main.cpp', DEFAULT_EXCLUDED_DIRS), false);
		assert.strictEqual(isExcludedSource('algorithms/sort.cpp', DEFAULT_EXCLUDED_DIRS), false);
	});

	test('Visual Studio scratch and build folders are skipped, at any depth', () => {
		for (const p of ['enc_temp_folder/97a0c4f1/main.cpp', 'x64/Debug/gen.cpp', 'Debug/a.cpp', 'sub/.vs/x.cpp', 'a/Release/b.cpp']) {
			assert.strictEqual(isExcludedSource(p, DEFAULT_EXCLUDED_DIRS), true, p);
		}
	});

	test('matching ignores case and both slash styles', () => {
		const backslash = String.fromCharCode(92);
		assert.strictEqual(isExcludedSource(['ENC_TEMP_FOLDER', 'x', 'main.cpp'].join(backslash), DEFAULT_EXCLUDED_DIRS), true);
	});

	test('only directory names match, never the file name or a substring', () => {
		assert.strictEqual(isExcludedSource('Debug.cpp', DEFAULT_EXCLUDED_DIRS), false);
		assert.strictEqual(isExcludedSource('debugging/a.cpp', DEFAULT_EXCLUDED_DIRS), false);
	});

	test('the list is configurable', () => {
		assert.strictEqual(isExcludedSource('tests/main.cpp', ['tests']), true);
		assert.strictEqual(isExcludedSource('build/a.cpp', ['tests']), false);
	});
});
