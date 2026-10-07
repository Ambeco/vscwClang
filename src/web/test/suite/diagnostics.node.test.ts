import * as assert from 'assert';
import { parseDiagnostics, withFailureFallback, workspaceAnchor } from '../../toolchain/diagnostics';

suite('parseDiagnostics', () => {
	test('error with column and flag', () => {
		const [d] = parseDiagnostics('/workspace/a.cpp:3:9: warning: unused variable \'x\' [-Wunused-variable]');
		assert.deepStrictEqual(d, { file: '/workspace/a.cpp', line: 3, column: 9, severity: 'warning', message: 'unused variable \'x\'', flag: '-Wunused-variable', notes: [] });
	});

	test('fatal error maps to error; message may contain colons', () => {
		const [d] = parseDiagnostics('/workspace/a.cpp:1:10: fatal error: \'nope.h\' file not found: really');
		assert.strictEqual(d.severity, 'error');
		assert.strictEqual(d.message, '\'nope.h\' file not found: really');
	});

	test('notes attach to the preceding diagnostic; summary and include-chain lines are dropped', () => {
		const out = parseDiagnostics([
			'In file included from /workspace/a.cpp:1:',
			'/workspace/b.h:2:5: error: unknown type name \'Foo\'',
			'/workspace/b.h:1:8: note: did you mean \'Bar\'?',
			'/workspace/a.cpp:9:1: warning: x [-Wfoo]',
			'1 error and 1 warning generated.',
		].join('\n'));
		assert.strictEqual(out.length, 2);
		assert.strictEqual(out[0].notes.length, 1);
		assert.strictEqual(out[0].notes[0].line, 1);
		assert.strictEqual(out[1].notes.length, 0);
	});

	test('wasm-ld error has no file and keeps >>> details as notes', () => {
		const [d] = parseDiagnostics([
			'wasm-ld: error: /workspace/a.o: undefined symbol: foo()',
			'>>> referenced by a.cpp',
			'>>>               /workspace/a.o:(main)',
		].join('\r\n'));
		assert.strictEqual(d.file, undefined);
		assert.strictEqual(d.message, '/workspace/a.o: undefined symbol: foo()');
		assert.deepStrictEqual(d.notes.map(n => n.message), ['referenced by a.cpp', '              /workspace/a.o:(main)']);
	});

	test('line without column', () => {
		const [d] = parseDiagnostics('/workspace/a.cpp:7: error: boom');
		assert.deepStrictEqual([d.line, d.column], [7, undefined]);
	});

	test('bare driver errors without a location are parsed', () => {
		const out = parseDiagnostics([
			'clang++: error: unknown argument: \'-foo\'',
			'error: unable to open output file \'/x.o\': \'Operation not permitted\'',
			'clang: warning: argument unused during compilation: \'-bar\' [-Wunused-command-line-argument]',
		].join('\n'));
		assert.deepStrictEqual(out.map(d => [d.file, d.severity, d.message, d.flag]), [
			[undefined, 'error', 'unknown argument: \'-foo\'', undefined],
			[undefined, 'error', 'unable to open output file \'/x.o\': \'Operation not permitted\'', undefined],
			[undefined, 'warning', 'argument unused during compilation: \'-bar\'', '-Wunused-command-line-argument'],
		]);
	});

	test('failure fallback synthesizes an error only when needed', () => {
		assert.deepStrictEqual(withFailureFallback([], 0, 'whatever'), []);
		const existing = parseDiagnostics('/w/a.cpp:1:1: error: x');
		assert.strictEqual(withFailureFallback(existing, 1, 'x'), existing);
		const [d] = withFailureFallback([], 1, 'odd output\n\nmore');
		assert.strictEqual(d.severity, 'error');
		assert.match(d.message, /exit 1.*odd output \| more/);
		assert.match(withFailureFallback([], 2, '')[0].message, /no output/);
	});

	test('garbage yields nothing', () => {
		assert.deepStrictEqual(parseDiagnostics('hello\n\nworld'), []);
	});
});

suite('workspaceAnchor', () => {
	const inWs = (f: string) => f.startsWith('/workspace/');
	const note = (file: string, line: number) => ({ file, line, severity: 'note' as const, message: 'in instantiation of x requested here', notes: [] });

	test('a diagnostic in the workspace is its own anchor', () => {
		const d = { file: '/workspace/a.cpp', line: 3, severity: 'error' as const, message: 'm', notes: [note('/workspace/b.cpp', 9)] };
		assert.strictEqual(workspaceAnchor(d, inWs), d);
	});

	test('an error inside a library header anchors at the last workspace note', () => {
		const d = { file: '/sysroot/include/c++/v1/memory', line: 34, severity: 'error' as const, message: 'm',
			notes: [note('/sysroot/include/c++/v1/vector', 10), note('/workspace/inner.hpp', 20), note('/workspace/main.cpp', 7)] };
		assert.strictEqual(workspaceAnchor(d, inWs)?.file, '/workspace/main.cpp');
		assert.strictEqual(workspaceAnchor(d, inWs)?.line, 7);
	});

	test('nothing in the workspace means no anchor', () => {
		const d = { file: '/sysroot/x.h', line: 1, severity: 'error' as const, message: 'm', notes: [note('/sysroot/y.h', 2)] };
		assert.strictEqual(workspaceAnchor(d, inWs), undefined);
		assert.strictEqual(workspaceAnchor({ severity: 'error', message: 'linker', notes: [] }, inWs), undefined);
	});
});
