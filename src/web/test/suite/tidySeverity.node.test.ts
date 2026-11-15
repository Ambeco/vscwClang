import * as assert from 'assert';
import { raiseTidyHints } from '../../clangd/tidySeverity';

suite('clang-tidy severity', () => {
	test('a clang-tidy Hint becomes a Warning and keeps its other fields', () => {
		const d = { source: 'clang-tidy', severity: 3, code: 'modernize-use-nullptr', message: 'use nullptr' };
		assert.deepStrictEqual(raiseTidyHints([d]), [{ ...d, severity: 1 }]);
		assert.strictEqual(d.severity, 3, 'input is not mutated');
	});

	test('other sources and severities are untouched', () => {
		const list = [
			{ source: 'clang', severity: 3 },
			{ source: 'clang-tidy', severity: 2 },
			{ source: 'clang-tidy', severity: 0 },
			{ severity: 3 },
		];
		assert.strictEqual(raiseTidyHints(list), list, 'same array when nothing changes');
	});

	test('mixed lists change only the tidy hints', () => {
		const out = raiseTidyHints([{ source: 'clang', severity: 3 }, { source: 'clang-tidy', severity: 3 }]);
		assert.deepStrictEqual(out.map(d => d.severity), [3, 1]);
	});

	test('class instances keep their prototype', () => {
		class Diag { source = 'clang-tidy'; severity = 3; hello() { return 'hi'; } }
		const out = raiseTidyHints([new Diag()]);
		assert.strictEqual(out[0].severity, 1);
		assert.strictEqual(out[0].hello(), 'hi');
	});
});
