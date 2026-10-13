import * as assert from 'assert';
import { resolveVariables } from '../../toolchain/projectModel';
import { clangdLogLevel, compileCommandsPath, cppToolsFlags, logsClangdStderr, mergeExclude } from '../../toolchain/cppToolsSettings';

const resolve = (text: string) => resolveVariables(text, { folderName: 'proj' });
const flagsFor = (settings: Parameters<typeof cppToolsFlags>[0]) => cppToolsFlags(settings, resolve);

suite('cppToolsFlags', () => {
	test('nothing configured gives no flags', () => {
		assert.deepStrictEqual(flagsFor({}), { flags: [], cFlags: [], cppFlags: [], notes: [] });
	});

	test('defines, standard and compiler args map to clang flags', () => {
		const { flags, cppFlags, notes } = flagsFor({ defines: ['DEBUG', 'LEVEL=2'], cppStandard: 'gnu++17', compilerArgs: ['-Wall', ' -Wextra '] });
		assert.deepStrictEqual(flags, ['-DDEBUG', '-DLEVEL=2', '-Wall', '-Wextra']);
		assert.deepStrictEqual(cppFlags, ['-std=gnu++17']);
		assert.deepStrictEqual(notes, []);
	});

	test('include paths inside the workspace map to /workspace', () => {
		const { flags, notes } = flagsFor({ includePath: ['${workspaceFolder}/include', '${workspaceFolder}', 'src/', './lib', '${workspaceFolder}/include'] });
		assert.deepStrictEqual(flags, ['-I/workspace/include', '-I/workspace', '-I/workspace/src', '-I/workspace/lib']);
		assert.deepStrictEqual(notes, []);
	});

	test('a trailing /** is read as the directory, with a note', () => {
		const { flags, notes } = flagsFor({ includePath: ['${workspaceFolder}/**'] });
		assert.deepStrictEqual(flags, ['-I/workspace']);
		assert.strictEqual(notes.length, 1);
		assert.match(notes[0], /recursive/);
	});

	test('include paths outside the workspace are dropped with a did-you-mean', () => {
		const { flags, notes } = flagsFor({ includePath: ['C:/Program Files/lib', '/usr/include', '${env:BOOST}/include', '~/x', '${workspaceFolder}/ok'] });
		assert.deepStrictEqual(flags, ['-I/workspace/ok']);
		assert.strictEqual(notes.length, 4);
		assert.match(notes[0], /Did you mean/);
	});

	test('backslashes in Windows-style include paths are accepted', () => {
		const backslash = String.fromCharCode(92);
		assert.deepStrictEqual(flagsFor({ includePath: [['${workspaceFolder}', 'inc'].join(backslash)] }).flags, ['-I/workspace/inc']);
	});

	test('each standard is kept apart for its own language', () => {
		const { flags, cFlags, cppFlags, notes } = flagsFor({ cStandard: 'gnu11', cppStandard: 'c++20' });
		assert.deepStrictEqual([flags, cFlags, cppFlags, notes], [[], ['-std=gnu11'], ['-std=c++20'], []]);
	});

	test('a standard of the wrong language, garbage, or ${default}', () => {
		const wrong = flagsFor({ cppStandard: 'c99', cStandard: 'c++17' });
		assert.deepStrictEqual([wrong.cFlags, wrong.cppFlags, wrong.notes.length], [[], [], 2]);
		assert.deepStrictEqual(flagsFor({ cppStandard: '${default}', cStandard: '${default}' }).notes, []);
	});

	test('variables are expanded in every entry, and unsupported ones are skipped with a note', () => {
		const { flags, notes } = flagsFor({ defines: ['ROOT="${workspaceFolder}"', 'NAME=${workspaceFolderBasename}', 'X=${env:HOME}'], compilerArgs: ['-I${workspaceRoot}/gen', '-DOPT=${command:foo}'], includePath: ['${default}', '${workspaceFolder}/${workspaceFolderBasename}'] });
		assert.deepStrictEqual(flags, ['-I/workspace/proj', '-DROOT="/workspace"', '-DNAME=proj', '-I/workspace/gen']);
		assert.strictEqual(notes.length, 2);
		assert.match(notes[0], /C_Cpp\.default\.defines entry 'X=\$\{env:HOME\}' was skipped: unsupported variable/);
	});

	test('non-array values are ignored', () => {
		assert.deepStrictEqual(flagsFor({ defines: 'X', includePath: 5, compilerArgs: {} }).flags, []);
	});
});

suite('compileCommandsPath', () => {
	test('string and array forms', () => {
		assert.strictEqual(compileCommandsPath('build/compile_commands.json'), 'build/compile_commands.json');
		assert.strictEqual(compileCommandsPath(['', 'out/cc.json', 'other.json']), 'out/cc.json');
	});

	test('workspaceFolder prefix is stripped', () => {
		assert.strictEqual(compileCommandsPath('${workspaceFolder}/build/compile_commands.json'), 'build/compile_commands.json');
	});

	test('empty or wrong-typed values give undefined', () => {
		for (const v of [undefined, '', '  ', [], [''], 3, null]) { assert.strictEqual(compileCommandsPath(v), undefined, String(v)); }
	});
});

suite('logging levels', () => {
	test('map to clangd levels', () => {
		assert.deepStrictEqual(['None', 'Error', 'Warning', 'Information', 'Debug'].map(clangdLogLevel), ['error', 'error', 'error', 'info', 'verbose']);
	});

	test('stderr is echoed above Error', () => {
		assert.deepStrictEqual(['None', 'Error', 'Warning', 'Information', 'Debug'].map(logsClangdStderr), [false, false, true, true, true]);
	});
});

suite('mergeExclude', () => {
	test('cpptools beats our default, ours beats cpptools when the user set it', () => {
		assert.deepStrictEqual(mergeExclude({ a: true, b: true }, false, { b: false, c: true }), { a: true, b: false, c: true });
		assert.deepStrictEqual(mergeExclude({ a: true, b: true }, true, { b: false, c: true }), { a: true, b: true, c: true });
	});

	test('a missing or malformed cpptools value changes nothing', () => {
		for (const v of [undefined, null, ['x'], 'x']) { assert.deepStrictEqual(mergeExclude({ a: true }, false, v), { a: true }); }
	});
});
