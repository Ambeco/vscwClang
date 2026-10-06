import * as assert from 'assert';
import { fromGuestPath, toGuestPath } from '../../toolchain/guestPaths';

suite('guestPaths', () => {
	test('maps in and out of the workspace', () => {
		assert.strictEqual(toGuestPath('/ws/proj', '/ws/proj/src/a.cpp'), '/workspace/src/a.cpp');
		assert.strictEqual(toGuestPath('/ws/proj/', '/ws/proj/a.cpp'), '/workspace/a.cpp');
		assert.strictEqual(fromGuestPath('/ws/proj', '/workspace/src/a.cpp'), '/ws/proj/src/a.cpp');
	});

	test('rejects lookalike siblings and unrelated paths', () => {
		assert.strictEqual(toGuestPath('/ws/proj', '/ws/proj2/a.cpp'), undefined);
		assert.strictEqual(fromGuestPath('/ws/proj', '/workspace2/a.cpp'), undefined);
		assert.strictEqual(fromGuestPath('/ws/proj', '/sysroot/include/x.h'), undefined);
	});
});
