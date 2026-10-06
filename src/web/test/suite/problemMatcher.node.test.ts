import * as assert from 'assert';

// Node-only test (see scripts/test-node.mjs); the project has no @types/node.
declare const require: (path: string) => any;
const pkg = require('../../../../package.json');

const matcher = pkg.contributes.problemMatchers.find((m: { name: string }) => m.name === 'vscwclang')!;
const regexp = new RegExp(matcher.pattern.regexp);
const groups = (line: string) => { const m = regexp.exec(line); return m && { file: m[matcher.pattern.file], line: m[matcher.pattern.line], column: m[matcher.pattern.column], severity: m[matcher.pattern.severity], message: m[matcher.pattern.message], code: m[matcher.pattern.code] }; };

suite('$vscwclang problem matcher', () => {
	test('error with workspace-relative file', () => {
		assert.deepStrictEqual(groups("/workspace/src/main.cpp:8:13: error: use of undeclared identifier 'missing'"),
			{ file: 'src/main.cpp', line: '8', column: '13', severity: 'error', message: "use of undeclared identifier 'missing'", code: undefined });
	});

	test('warning with flag splits the code from the message', () => {
		assert.deepStrictEqual(groups('/workspace/a.cpp:3:7: warning: unused variable \'x\' [-Wunused-variable]'),
			{ file: 'a.cpp', line: '3', column: '7', severity: 'warning', message: "unused variable 'x'", code: '-Wunused-variable' });
	});

	test('notes, linker and driver lines do not match', () => {
		assert.strictEqual(groups("/workspace/a.cpp:3:12: note: to match this '{'"), null);
		assert.strictEqual(groups('wasm-ld: error: undefined symbol: f()'), null);
		assert.strictEqual(groups('clang++: error: no such file'), null);
	});
});
