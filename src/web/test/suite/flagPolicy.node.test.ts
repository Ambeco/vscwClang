import * as assert from 'assert';
import { checkUserFlags } from '../../toolchain/flagPolicy';

suite('checkUserFlags', () => {
	test('ordinary flags pass', () => {
		assert.deepStrictEqual(checkUserFlags(['-std=c++20', '-O2', '-Wall', '-DFOO=1', '-Iinclude', '-I', 'src', '-I/workspace/x', '-isystem/sysroot/include']), []);
	});

	for (const bad of ['-fplugin=x.so', '-fuse-ld=gold', '-B/usr/bin', '--sysroot=/x', '-resource-dir=/y', '--target=x86_64-linux', '-target', '-march=native', '-o', '-c']) {
		test(`rejects ${bad} with a suggestion`, () => {
			const p = checkUserFlags([bad]);
			assert.strictEqual(p.length, 1);
			assert.match(p[0], /Did you mean/);
			assert.ok(p[0].includes(`'${bad}'`));
		});
	}

	test('host include paths are rejected, including the separated form and ..', () => {
		assert.strictEqual(checkUserFlags(['-I/usr/include']).length, 1);
		assert.strictEqual(checkUserFlags(['-I', 'C:\\inc']).length, 1);
		assert.strictEqual(checkUserFlags(['-I../../etc']).length, 1);
		assert.strictEqual(checkUserFlags(['-I', '/usr/include', '-O2']).length, 1);
	});

	test('--no-gc-sections is rejected in every spelling', () => {
		for (const flags of [['-Wl,--no-gc-sections'], ['-Wl,--export=a,--no-gc-sections'], ['-Xlinker', '--no-gc-sections']]) {
			const p = checkUserFlags(flags);
			assert.strictEqual(p.length, 1, flags.join(' '));
			assert.match(p[0], /Did you mean/);
			assert.match(p[0], /issues\/303/);
		}
		assert.deepStrictEqual(checkUserFlags(['-Wl,--gc-sections', '-Wl,--export=a']), []);
	});

	test('reports every problem', () => {
		assert.strictEqual(checkUserFlags(['-fplugin=a', '-O2', '-fuse-ld=lld']).length, 2);
	});
});
