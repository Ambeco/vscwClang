import * as assert from 'assert';
import { hostToGuest, inferHostRoot, planFromCompileCommands, planFromCompileFlags } from '../../toolchain/projectModel';

const ROOT = '/home/u/proj';

// What CMake + Ninja writes on Linux (`arguments` form is what Bear writes).
const cmake = [
	{ directory: '/home/u/proj/build', file: '/home/u/proj/src/app.cpp', output: 'CMakeFiles/app.dir/src/app.cpp.o',
		command: '/usr/bin/c++ -DNAME=1 -I/home/u/proj/include -isystem /usr/include/foo -std=c++17 -g -fPIC -MD -MT CMakeFiles/app.dir/src/app.cpp.o -MF CMakeFiles/app.dir/src/app.cpp.o.d -o CMakeFiles/app.dir/src/app.cpp.o -c /home/u/proj/src/app.cpp' },
	{ directory: '/home/u/proj/build', file: '/home/u/proj/src/tool.cpp', output: 'CMakeFiles/tool.dir/src/tool.cpp.o',
		command: '/usr/bin/c++ -O2 -I../include -o CMakeFiles/tool.dir/src/tool.cpp.o -c ../src/tool.cpp' },
];

suite('planFromCompileCommands', () => {
	test('each entry keeps its own flags and loses the database mechanics', () => {
		const plan = planFromCompileCommands(cmake, ROOT);
		assert.deepStrictEqual(plan.sources, ['src/app.cpp', 'src/tool.cpp']);
		assert.deepStrictEqual(plan.perFileFlags['src/app.cpp'], ['-DNAME=1', '-I/workspace/include', '-std=c++17', '-g', '-fPIC']);
		assert.deepStrictEqual(plan.perFileFlags['src/tool.cpp'], ['-O2', '-I/workspace/include']);
		assert.ok(plan.notes.some(n => n.includes("-isystem/usr/include/foo")), plan.notes.join('|'));
		assert.deepStrictEqual(plan.targets, ['app', 'tool']);
		assert.strictEqual(plan.mode, 'debug');
	});

	test('a target keeps only its own entries', () => {
		const plan = planFromCompileCommands(cmake, ROOT, 'tool');
		assert.deepStrictEqual(plan.sources, ['src/tool.cpp']);
		assert.strictEqual(plan.mode, 'release');
		assert.throws(() => planFromCompileCommands(cmake, ROOT, 'nope'), /no usable C\/C\+\+ entries for target 'nope'/);
	});

	test('arguments form (Bear), ccache wrapper, no targets', () => {
		const plan = planFromCompileCommands([{ directory: ROOT, file: 'main.c', arguments: ['ccache', 'gcc', '-Wall', '-c', 'main.c', '-o', 'main.o'] }], ROOT);
		assert.deepStrictEqual(plan.perFileFlags, { 'main.c': ['-Wall'] });
		assert.deepStrictEqual(plan.targets, []);
	});

	test('Windows database with backslashes and a different drive-letter case', () => {
		const plan = planFromCompileCommands([{
			directory: 'C:/Users/x/proj/build', file: 'C:\\Users\\x\\proj\\src\\a.cpp',
			command: '"C:\\mingw\\bin\\g++.exe" -IC:\\Users\\x\\proj\\inc -DX="a b" -c C:\\Users\\x\\proj\\src\\a.cpp -o a.o',
		}], '/c:/users/x/proj');
		assert.deepStrictEqual(plan.perFileFlags['src/a.cpp'], ['-I/workspace/inc', '-DX=a b']);
	});

	test('duplicates, non-C++ files and outside files are skipped with notes', () => {
		const plan = planFromCompileCommands([
			{ directory: ROOT, file: 'a.cpp', arguments: ['g++', '-DA', 'a.cpp'] },
			{ directory: ROOT, file: 'a.cpp', arguments: ['g++', '-DB', 'a.cpp'] },
			{ directory: ROOT, file: 'start.S', arguments: ['gcc', 'start.S'] },
			{ directory: '/elsewhere', file: '/elsewhere/z.cpp', arguments: ['g++', 'z.cpp'] },
		], ROOT);
		assert.deepStrictEqual(plan.perFileFlags, { 'a.cpp': ['-DA'] });
		assert.strictEqual(plan.notes.filter(n => /second entry|not a C\/C\+\+|outside the workspace folder/.test(n)).length, 3);
	});

	test('failures name the entry and suggest a fix', () => {
		assert.throws(() => planFromCompileCommands({}, ROOT), /must be a JSON array.*Did you mean/);
		assert.throws(() => planFromCompileCommands([{ file: 'a.cpp' }], ROOT), /entry 0 needs a 'file' and a 'command'/);
		assert.throws(() => planFromCompileCommands([{ directory: ROOT, file: 'a.cpp', command: 'cl.exe /c a.cpp' }], ROOT), /entry 'a\.cpp': .*MSVC/);
		assert.throws(() => planFromCompileCommands([{ directory: ROOT, file: 'a.cpp', command: 'g++ @flags.rsp a.cpp' }], ROOT), /response file '@flags\.rsp'/);
		assert.throws(() => planFromCompileCommands([{ directory: ROOT, file: 'a.cpp', command: 'g++ -march=native a.cpp' }], ROOT), /-march=native.*not allowed/);
		assert.throws(() => planFromCompileCommands([{ directory: '/x', file: '/x/a.cpp', command: 'g++ a.cpp' }], ROOT), /no usable C\/C\+\+ entries.*generated for/);
	});
});

suite('hostToGuest and inferHostRoot', () => {
	test('maps under the root only', () => {
		assert.strictEqual(hostToGuest('/home/u/proj/src', '/workspace', ROOT), '/workspace/src');
		assert.strictEqual(hostToGuest('../inc', '/workspace/build', ROOT), '/workspace/inc');
		assert.strictEqual(hostToGuest('../../x', '/workspace/build', ROOT), undefined);
		assert.strictEqual(hostToGuest('/home/u/projX/src', '/workspace', ROOT), undefined);
		assert.strictEqual(hostToGuest('/usr/include', '/workspace', ROOT), undefined);
		assert.strictEqual(hostToGuest('C:\\P\\src', '/workspace', '/c:/p'), '/workspace/src');
	});

	test('a workspace root of "/" maps everything, so callers must check existence', () => {
		assert.strictEqual(hostToGuest('/usr/include', '/workspace', '/'), '/workspace/usr/include');
		assert.strictEqual(hostToGuest('src', '/workspace', '/'), '/workspace/src');
	});

	test('infers the root from the longest existing tail', () => {
		const exists = (rel: string) => rel === 'src/app.cpp';
		assert.strictEqual(inferHostRoot(cmake, exists), '/home/u/proj');
		assert.strictEqual(inferHostRoot([{ directory: 'D:\\ci\\w', file: 'src\\app.cpp' }], exists), 'D:/ci/w');
		assert.strictEqual(inferHostRoot(cmake, () => false), undefined);
	});
});

suite('planFromCompileFlags', () => {
	test('one flag per line, paths from the workspace folder', () => {
		const plan = planFromCompileFlags('\uFEFF-std=c++20\n-Iinclude\r\n\n-DX=1\n-isystem\n/usr/include\n');
		assert.deepStrictEqual(plan.flags, ['-std=c++20', '-I/workspace/include', '-DX=1']);
		assert.deepStrictEqual(plan.sources, []);
		assert.ok(plan.notes.some(n => n.includes('outside the workspace')));
	});
});
