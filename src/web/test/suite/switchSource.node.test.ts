import * as assert from 'assert';
import { pickCounterpart } from '../../switchSource';

suite('pickCounterpart', () => {
	test('pairs a source with the header next to it, and back', () => {
		assert.strictEqual(pickCounterpart('a.cpp', ['a.cpp', 'a.h', 'b.h']), 'a.h');
		assert.strictEqual(pickCounterpart('a.h', ['a.cpp', 'a.h', 'b.cpp']), 'a.cpp');
	});

	test('the same folder beats a more distant match', () => {
		assert.strictEqual(pickCounterpart('src/a.cpp', ['include/a.h', 'src/a.h']), 'src/a.h');
	});

	test('include/src layouts pair by shared subfolders', () => {
		assert.strictEqual(pickCounterpart('include/foo/a.h', ['other/a.cpp', 'src/foo/a.cpp', 'src/a.cpp']), 'src/foo/a.cpp');
	});

	test('extension priority and case-insensitivity', () => {
		assert.strictEqual(pickCounterpart('a.cpp', ['a.hpp', 'a.h']), 'a.h');
		assert.strictEqual(pickCounterpart('A.CPP', ['A.HPP']), 'A.HPP');
		assert.strictEqual(pickCounterpart('a.h', ['a.c', 'a.cpp']), 'a.cpp');
	});

	test('backslashes work, and different stems or non-C files give undefined', () => {
		assert.strictEqual(pickCounterpart('src\\a.cpp', ['src\\a.h']), 'src\\a.h');
		assert.strictEqual(pickCounterpart('a.cpp', ['b.h', 'a.cpp', 'a.txt']), undefined);
		assert.strictEqual(pickCounterpart('readme.md', ['readme.h']), undefined);
	});
});
