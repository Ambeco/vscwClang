import * as assert from 'assert';
import { indexTargetsFromTasks } from '../../toolchain/indexTargets';
import { compilationDatabaseChanges } from '../../clangd/clangdConfig';

const DEFAULTS = ['**/*.{c,cc,cpp,cxx}'];

suite('indexTargetsFromTasks', () => {
	test('a g++ task becomes a target with its sources and compile flags', () => {
		const { targets, notes } = indexTargetsFromTasks([
			{ label: 'app', type: 'shell', command: 'g++', args: ['-g', '-std=c++20', '-DFOO=1', '-I${workspaceFolder}/include', '${workspaceFolder}/src/*.cpp', '-o', '${workspaceFolder}/app'] },
		], 'proj', DEFAULTS);
		assert.deepStrictEqual(notes, []);
		assert.strictEqual(targets.length, 1);
		assert.deepStrictEqual(targets[0].sources, ['src/*.cpp']);
		for (const flag of ['-std=c++20', '-DFOO=1', '-I/workspace/include']) { assert.ok(targets[0].flags.includes(flag), `${flag} in ${targets[0].flags.join(' ')}`); }
	});

	test('a vscwclang task uses its own sources and flags, or the default sources when it has none', () => {
		const { targets } = indexTargetsFromTasks([
			{ label: 'one', type: 'vscwclang', sources: ['${workspaceFolder}/a/*.cpp'], flags: ['-DX'] },
			{ label: 'all', type: 'vscwclang' },
		], 'proj', DEFAULTS);
		assert.deepStrictEqual(targets.map(t => t.sources), [['a/*.cpp'], DEFAULTS]);
		assert.ok(targets[0].flags.includes('-DX'));
		assert.deepStrictEqual(targets[1].flags, []);
	});

	test('a task that needs the editor is skipped with a note and does not hide the others', () => {
		const { targets, notes } = indexTargetsFromTasks([
			{ label: 'current file', type: 'shell', command: 'g++', args: ['${file}'] },
			{ label: 'lib', type: 'shell', command: 'clang++', args: ['lib.cpp'] },
		], 'proj', DEFAULTS);
		assert.deepStrictEqual(targets.map(t => t.label), ['lib']);
		assert.strictEqual(notes.length, 1);
		assert.match(notes[0], /not indexing task 'current file'.*active C\/C\+\+ file/);
	});

	test('tasks that run other programs name no target, and so does a missing or malformed tasks array', () => {
		assert.deepStrictEqual(indexTargetsFromTasks([{ label: 'make', type: 'shell', command: 'make' }, null, 'x'], 'proj', DEFAULTS).targets, []);
		assert.deepStrictEqual(indexTargetsFromTasks(undefined, 'proj', DEFAULTS), { targets: [], notes: [] });
	});
});

suite('compilationDatabaseChanges per-file flags', () => {
	test('a file\'s own flags follow the shared ones, and files without any get only the shared flags', () => {
		const changes = compilationDatabaseChanges(['/workspace/a.cpp', '/workspace/b.cpp'], ['--target=wasm32'], { '/workspace/a.cpp': ['-DFOO'] });
		assert.deepStrictEqual(changes['/workspace/a.cpp'].compilationCommand, ['clang', '--target=wasm32', '-DFOO', '--', '/workspace/a.cpp']);
		assert.deepStrictEqual(changes['/workspace/b.cpp'].compilationCommand, ['clang', '--target=wasm32', '--', '/workspace/b.cpp']);
	});
});
