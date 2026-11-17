import * as assert from 'assert';
import { ClassifyError, classifyShellLine, type BuildAction } from '../../buildgraph/classify';

const ctx = { cwd: '/workspace' };
const one = (line: string, c = ctx): BuildAction => {
	const r = classifyShellLine(line, c);
	assert.strictEqual(r.actions.length, 1, `${line} -> ${JSON.stringify(r.actions)}`);
	return r.actions[0];
};
const without = ({ command: _command, ...rest }: BuildAction) => rest;
const rejects = (line: string, pattern: RegExp, c = ctx) =>
	assert.throws(() => classifyShellLine(line, c), (e: unknown) => e instanceof ClassifyError && pattern.test(e.message) && /Did you mean/.test(e.message), line);

suite('classifyShellLine', () => {
	test('a -c compile names its source, output and flags', () => {
		assert.deepStrictEqual(without(one('cc -O2 -Wall -c lib.c -o lib.o')), { kind: 'compile', source: '/workspace/lib.c', output: '/workspace/lib.o', flags: ['-O2', '-Wall'] });
		assert.deepStrictEqual(without(one('g++ -std=c++17 -Iinclude -DNAME=1 -c src/a.cpp')), { kind: 'compile', source: '/workspace/src/a.cpp', output: '/workspace/a.o', flags: ['-std=c++17', '-I/workspace/include', '-DNAME=1'] });
	});

	test('dependency-file flags are dropped from compiles', () => {
		assert.deepStrictEqual((one('cc -MMD -MP -MF a.d -MT a.o -c a.c -o a.o') as { flags: string[] }).flags, []);
	});

	test('forbidden target, sysroot and linker flags are dropped with a note', () => {
		const r = classifyShellLine('clang --target=x86_64-linux-gnu --sysroot /opt/sr -fuse-ld=lld -B/usr/bin -march=native -c a.c -o a.o', ctx);
		assert.deepStrictEqual((r.actions[0] as { flags: string[] }).flags, []);
		assert.strictEqual(r.notes.length, 5);
		assert.ok(r.notes[1].includes('--sysroot /opt/sr'));
	});

	test('a link with objects, libraries and -L/-l flags', () => {
		assert.deepStrictEqual(without(one('cc -o test t.o libx.a -L. -lx -lm')), { kind: 'link', inputs: ['/workspace/t.o', '/workspace/libx.a'], output: '/workspace/test', flags: ['-L/workspace', '-lx', '-lm'] });
	});

	test('compile-and-link in one command lists the sources as inputs', () => {
		assert.deepStrictEqual(without(one('c++ -o app main.cpp util.cpp')), { kind: 'link', inputs: ['/workspace/main.cpp', '/workspace/util.cpp'], output: '/workspace/app', flags: [] });
	});

	test('compiler wrappers, absolute tool paths and versioned names are looked through', () => {
		assert.strictEqual(one('ccache cc -c a.c -o a.o').kind, 'compile');
		assert.strictEqual(one('/usr/bin/x86_64-linux-gnu-g++-12 -c a.cc -o a.o').kind, 'compile');
	});

	test('absolute host paths are rebased with hostRoot, others are rejected', () => {
		const c = { cwd: '/workspace', hostRoot: 'C:/proj' };
		assert.deepStrictEqual(without(one('cc -IC:/proj/inc -c C:/proj/src/a.c -o C:/proj/build/a.o', c)), { kind: 'compile', source: '/workspace/src/a.c', output: '/workspace/build/a.o', flags: ['-I/workspace/inc'] });
		rejects('cc -c /elsewhere/a.c -o a.o', /outside the workspace/);
	});

	test('compile steps must be single-source, shared libraries and rejected flags fail', () => {
		rejects('cc -c a.c b.c', /exactly one source/);
		rejects('cc -shared -o x.so a.o', /shared libraries/);
		rejects('cc -S a.c', /not allowed/);
		rejects('cc -o x', /no input files/);
		rejects('cc -c a.s', /cannot use 'a.s'/);
	});

	test('ar creates an archive from objects, ranlib is a no-op', () => {
		assert.deepStrictEqual(without(one('ar rcs libx.a a.o b.o')), { kind: 'archive', output: '/workspace/libx.a', members: ['/workspace/a.o', '/workspace/b.o'] });
		assert.strictEqual(one('llvm-ar -cr build/libx.a build/a.o').kind, 'archive');
		assert.strictEqual(one('ranlib libx.a').kind, 'noop');
		rejects('ar t libx.a', /unsupported ar operation/);
		rejects('ar rcs libx.a', /needs an archive and its members/);
	});

	test('mkdir, rm, cp, mv, touch', () => {
		assert.deepStrictEqual(without(one('mkdir -p build/obj')), { kind: 'mkdir', paths: ['/workspace/build/obj'] });
		assert.deepStrictEqual(without(one('rm -f a.o b.o')), { kind: 'remove', paths: ['/workspace/a.o', '/workspace/b.o'], glob: false, recursive: false });
		assert.deepStrictEqual(without(one('rm -rf build *.o')), { kind: 'remove', paths: ['/workspace/build', '/workspace/*.o'], glob: true, recursive: true });
		assert.deepStrictEqual(without(one('cp -r a.h b.h inc')), { kind: 'copy', from: ['/workspace/a.h', '/workspace/b.h'], to: '/workspace/inc', recursive: true });
		assert.deepStrictEqual(without(one('mv a.tmp a.txt')), { kind: 'move', from: '/workspace/a.tmp', to: '/workspace/a.txt' });
		assert.deepStrictEqual(without(one('touch stamp')), { kind: 'touch', paths: ['/workspace/stamp'] });
		rejects('rm -i a', /unsupported option '-i'/);
		rejects('mkdir', /no directory/);
		rejects('cp a', /needs a source and a destination/);
		rejects('cp *.h inc', /wildcard/);
		rejects('mv a b c', /3? ?sources|2 sources/);
	});

	test('echo and printf into a file become writes, to the log become no-ops', () => {
		assert.deepStrictEqual(without(one("echo 'GEN=1' > gen.mk")), { kind: 'write', path: '/workspace/gen.mk', text: 'GEN=1\n', append: false });
		assert.deepStrictEqual(without(one('echo -n a b >> log')), { kind: 'write', path: '/workspace/log', text: 'a b', append: true });
		assert.deepStrictEqual(without(one('printf "a\\nb\\n" > f')), { kind: 'write', path: '/workspace/f', text: 'a\nb\n', append: false });
		assert.deepStrictEqual(without(one(': > empty')), { kind: 'write', path: '/workspace/empty', text: '', append: false });
		assert.strictEqual(one('echo hi').kind, 'noop');
		assert.strictEqual(one('echo hi >/dev/null').kind, 'noop');
		rejects('printf "%s" a > f', /'%' format/);
		rejects('echo -e "a\\nb" > f', /shell-specific/);
	});

	test('cd changes the directory for later commands on the line', () => {
		const r = classifyShellLine('cd sub && cc -c a.c -o a.o && cd .. && touch x', ctx);
		assert.deepStrictEqual(r.actions.map(a => without(a)), [
			{ kind: 'compile', source: '/workspace/sub/a.c', output: '/workspace/sub/a.o', flags: [] },
			{ kind: 'touch', paths: ['/workspace/x'] },
		]);
		assert.strictEqual(classifyShellLine('cd sub', ctx).cwd, '/workspace/sub');
		rejects('cd', /exactly one directory/);
		rejects('cd /etc && ls', /outside the workspace/);
	});

	test('"|| true" marks the previous command as allowed to fail; other || is rejected', () => {
		const r = classifyShellLine('rm -f a.o || true', ctx);
		assert.strictEqual(r.actions.length, 1);
		assert.strictEqual(r.actions[0].ignoreFailure, true);
		rejects('test -d x || mkdir x', /cannot map the command 'test'/);
		rejects('rm -f a || rm -f b', /only supported as/);
	});

	test('redirecting other output to a file is rejected, /dev/null and 2>&1 are fine', () => {
		assert.strictEqual(one('cc -c a.c -o a.o 2>&1').kind, 'compile');
		assert.strictEqual(one('cc -c a.c -o a.o >/dev/null 2>/dev/null').kind, 'compile');
		rejects('cc -c a.c -o a.o 2> err.log', /only supported for echo/);
		rejects('ar rcs x.a a.o > log', /only supported for echo/);
	});

	test('environment prefixes are ignored with a note', () => {
		const r = classifyShellLine('CCACHE_DISABLE=1 cc -c a.c -o a.o', ctx);
		assert.strictEqual(r.actions[0].kind, 'compile');
		assert.match(r.notes[0], /ignored environment CCACHE_DISABLE/);
	});

	test('unknown commands name the command and suggest a close one', () => {
		rejects('sed -i s/a/b/ f', /cannot map the command 'sed'/);
		rejects('mkdr -p x', /Did you mean 'mkdir'/);
		rejects('ls', /Did you mean to run this step on a desktop/);
		rejects('ln -s a b', /symbolic links/);
		rejects('false', /always fails/);
		rejects('python gen.py', /cannot map the command 'python'/);
	});

	test('shell syntax errors are not swallowed', () => {
		assert.throws(() => classifyShellLine('a | b', ctx), /pipelines/);
	});
});
