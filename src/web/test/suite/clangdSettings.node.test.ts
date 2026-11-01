import * as assert from 'assert';
import { clangdUserConfig, headersAreCpp, mapClangdSettings } from '../../clangd/clangdSettings';
import { clangdArgs } from '../../clangd/clangdConfig';

suite('clangd settings mapping', () => {
	test('unset or null settings map to nothing', () => {
		assert.deepStrictEqual(mapClangdSettings({}), { args: [], tidyAdd: [], tidyRemove: [], notes: [] });
		assert.deepStrictEqual(mapClangdSettings({ includeHeader: null, clangTidyEnabled: null, tidyChecksEnabled: null }).args, []);
	});

	test('includeHeader never disables header insertion; the others keep clangd default', () => {
		assert.deepStrictEqual(mapClangdSettings({ includeHeader: 'never' }).args, ['-header-insertion=never']);
		assert.deepStrictEqual(mapClangdSettings({ includeHeader: 'ifNeeded' }).args, []);
		assert.deepStrictEqual(mapClangdSettings({ includeHeader: 'always' }).args, []);
		assert.match(mapClangdSettings({ includeHeader: 'sometimes' }).notes[0], /not one of always, ifNeeded or never/);
	});

	test('clang-tidy enabled false turns it off and drops the check lists', () => {
		const m = mapClangdSettings({ clangTidyEnabled: false, tidyChecksEnabled: ['bugprone-*'], tidyChecksDisabled: ['x'] });
		assert.deepStrictEqual(m.args, ['-clang-tidy=false']);
		assert.deepStrictEqual([m.tidyAdd, m.tidyRemove], [[], []]);
		assert.match(m.notes[0], /ignored because clangTidy.enabled is false/);
	});

	test('check lists are trimmed and filtered', () => {
		const m = mapClangdSettings({ clangTidyEnabled: true, tidyChecksEnabled: [' bugprone-* ', '', 3], tidyChecksDisabled: ['modernize-*'] });
		assert.deepStrictEqual([m.args, m.tidyAdd, m.tidyRemove], [[], ['bugprone-*'], ['modernize-*']]);
	});

	test('settings with no clangd equivalent are reported with a suggestion', () => {
		const m = mapClangdSettings({ tidyHeaderFilter: '.*', tidyConfig: 'Checks: x', tidyFallbackConfig: '', tidyArgs: ['-x'] });
		assert.strictEqual(m.notes.length, 3);
		assert.match(m.notes.join('\n'), /headerFilter.*\.clang-tidy/s);
	});

	test('clangdArgs appends the mapped arguments', () => {
		assert.deepStrictEqual(clangdArgs('error', 2, ['-clang-tidy=false']).slice(-2), ['-log=error', '-clang-tidy=false']);
	});
});

suite('clangd user config', () => {
	test('.h is C++ unless the workspace is C only', () => {
		assert.strictEqual(headersAreCpp([]), true);
		assert.strictEqual(headersAreCpp(['/a/x.c']), false);
		assert.strictEqual(headersAreCpp(['/a/x.c', '/a/y.CPP']), true);
		assert.strictEqual(headersAreCpp(['/a/y.cc']), true);
	});

	test('C++ workspace: .h becomes a C++ header and each language gets its own standard', () => {
		const text = clangdUserConfig({ headersAsCpp: true, cppStd: '-std=c++20', cStd: '-std=c11', tidyAdd: [], tidyRemove: [] });
		assert.ok(text.includes("PathMatch: '.*\\.h'\nCompileFlags:\n  Add: ['-xc++-header']"), text);
		assert.ok(text.includes("PathMatch: '.*\\.(cc|cpp|cxx|C|hh|hpp|hxx|h)'\nCompileFlags:\n  Add: ['-std=c++20']"), text);
		assert.ok(text.includes("PathMatch: '.*\\.(c)'\nCompileFlags:\n  Add: ['-std=c11']"), text);
		assert.strictEqual(text.split('\n---\n').length, 3);
	});

	test('C-only workspace: .h gets the C standard and no C++ header flag', () => {
		const text = clangdUserConfig({ headersAsCpp: false, cppStd: '-std=c++20', cStd: '-std=c11', tidyAdd: [], tidyRemove: [] });
		assert.ok(!text.includes('xc++-header'));
		assert.ok(text.includes("PathMatch: '.*\\.(c|h)'\nCompileFlags:\n  Add: ['-std=c11']"), text);
		assert.ok(!text.includes('|h)'.concat("'\nCompileFlags:\n  Add: ['-std=c++20'")), text);
	});

	test('tidy checks become a Diagnostics fragment; nothing configured has no fragments', () => {
		const text = clangdUserConfig({ headersAsCpp: false, tidyAdd: ['bugprone-*'], tidyRemove: ['x-y'] });
		assert.ok(text.includes("Diagnostics:\n  ClangTidy:\n    Add: ['bugprone-*']\n    Remove: ['x-y']"), text);
		assert.ok(!clangdUserConfig({ headersAsCpp: false, tidyAdd: [], tidyRemove: [] }).includes('If:'));
	});
});
