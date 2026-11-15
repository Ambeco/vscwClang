import * as assert from 'assert';
import { overlayProperties, parseCppProperties, stripJsonc } from '../../toolchain/cppProperties';

const FILE = `{
	// cpptools writes comments and trailing commas
	"configurations": [
		{
			"name": "Linux", /* first wins */
			"includePath": ["\${workspaceFolder}/**", "//not-a-comment",],
			"defines": ["URL=\\"http://x\\""],
			"forcedInclude": ["pre.h"],
			"cppStandard": "c++17",
			"compileCommands": "build/compile_commands.json",
			"compilerPath": "/usr/bin/gcc",
			"configurationProvider": "ms-vscode.cmake-tools",
		},
		{ "name": "Win32", "cppStandard": "c++11" }
	],
	"version": 4,
}`;

suite('c_cpp_properties.json', () => {
	test('stripJsonc keeps comment-like text inside strings', () => {
		assert.deepStrictEqual(JSON.parse(stripJsonc('{"a": "x//y", /* c */ "b": [1,2,], // end\n}')), { a: 'x//y', b: [1, 2] });
		assert.strictEqual(JSON.parse(stripJsonc(String.raw`{"a": "q\\\"/*z*/"}`)).a, String.raw`q\"/*z*/`);
	});

	test('reads the first configuration and the keys we honor', () => {
		const p = parseCppProperties(FILE);
		assert.strictEqual(p.configName, 'Linux');
		assert.deepStrictEqual(p.includePath, ['${workspaceFolder}/**', '//not-a-comment']);
		assert.deepStrictEqual(p.defines, ['URL="http://x"']);
		assert.deepStrictEqual(p.forcedInclude, ['pre.h']);
		assert.strictEqual(p.cppStandard, 'c++17');
		assert.strictEqual(p.compileCommands, 'build/compile_commands.json');
		assert.match(p.notes[0], /configurationProvider 'ms-vscode\.cmake-tools' is not supported/);
		assert.strictEqual(p.notes.length, 1);
	});

	test('a BOM is accepted; invalid or empty files are noted with a suggestion', () => {
		assert.strictEqual(parseCppProperties('\uFEFF{"configurations":[{"name":"a"}]}').configName, 'a');
		assert.match(parseCppProperties('{ nope').notes[0], /not valid JSON.*Did you mean/);
		assert.match(parseCppProperties('{"configurations": []}').notes[0], /no "configurations" entry.*Did you mean/);
		assert.match(parseCppProperties('null').notes[0], /no "configurations" entry/);
	});

	test('the project file wins per key; settings fill the rest; empty file values do not override', () => {
		const p = parseCppProperties('{"configurations":[{"name":"a","defines":["A"],"includePath":[],"cppStandard":""}]}');
		const merged = overlayProperties({ defines: ['S'], includePath: ['inc'], cppStandard: 'c++20', cStandard: 'c11' }, p);
		assert.deepStrictEqual(merged, { defines: ['A'], includePath: ['inc'], forcedInclude: undefined, compilerArgs: undefined, cppStandard: 'c++20', cStandard: 'c11' });
	});

	test('no properties file leaves the settings as they are', () => {
		const settings = { defines: ['S'] };
		assert.strictEqual(overlayProperties(settings, undefined), settings);
	});
});
