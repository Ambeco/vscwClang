import * as assert from 'assert';
import { SINGLE_SLICE, THREADS_SLICE, chooseSlice } from '../../toolchain/threadSlice';

suite('chooseSlice', () => {
	const both = [SINGLE_SLICE, THREADS_SLICE];

	test('threads are the default when the toolchain has them', () => {
		assert.strictEqual(chooseSlice(both, true, [[]]), THREADS_SLICE);
	});

	test('the setting turns them off', () => {
		assert.strictEqual(chooseSlice(both, false, [['-O2']]), SINGLE_SLICE);
	});

	test('-pthread or -lpthread in any flag list wins over the setting', () => {
		assert.strictEqual(chooseSlice(both, false, [[], ['-pthread']]), THREADS_SLICE);
		assert.strictEqual(chooseSlice(both, false, [['-lpthread']]), THREADS_SLICE);
		assert.strictEqual(chooseSlice(both, false, [['-l', 'pthread']]), THREADS_SLICE);
	});

	test('a toolchain without the threads slice builds single-threaded unless -pthread asks', () => {
		assert.strictEqual(chooseSlice([SINGLE_SLICE], true, [[]]), SINGLE_SLICE);
		assert.throws(() => chooseSlice([SINGLE_SLICE], true, [['-pthread']]), /Did you mean to update the toolchain/);
	});
});
