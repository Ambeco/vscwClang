import * as assert from 'assert';
import { parseDiagnostics, withFailureFallback } from '../../toolchain/diagnostics';

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
