import * as assert from 'assert';
import { splitFlags } from '../../toolchain/flagPolicy';

suite('splitFlags', () => {
	test('compile flags stay on the compile side', () => {
		assert.deepStrictEqual(splitFlags(['-std=c++20', '-O2', '-DX=1', '-Iinc', '-Wall', '-Wno-unused'], '/workspace'), { compile: ['-std=c++20', '-O2', '-DX=1', '-Iinc', '-Wall', '-Wno-unused'], link: [] });
	});

	test('-l, -L and -Wl, go to the linker', () => {
		assert.deepStrictEqual(splitFlags(['-lm', '-l', 'foo', '-Llib', '-L', '/sysroot/x', '-Wl,--export=a,--no-gc-sections', '-O1'], '/workspace'),
			{ compile: ['-O1'], link: ['-lm', '-lfoo', '-L/workspace/lib', '-L/sysroot/x', '--export=a', '--no-gc-sections'] });
	});

	test('relative -L dirs are resolved under the guest workspace', () => {
		assert.deepStrictEqual(splitFlags(['-L./libs'], '/workspace').link, ['-L/workspace/libs']);
	});

	test('a dangling -l gets a did-you-mean', () => {
		assert.throws(() => splitFlags(['-l'], '/workspace'), /needs an argument.*Did you mean/);
	});
});
