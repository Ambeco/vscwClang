import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// VS Code cannot register a setting that is both a value and a parent: it logs "Ignoring <child> as <parent> is
// ..." and `get('<child>', fallback)` then returns the parent's value instead of the fallback.
suite('package.json settings', () => {
	test('no setting key is a dotted prefix of another', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
		const keys = Object.keys(pkg.contributes.configuration.properties) as string[];
		const conflicts: string[] = [];
		for (const parent of keys) {
			for (const child of keys) {
				if (child.startsWith(parent + '.')) { conflicts.push(`${child} nests under ${parent}; did you mean to rename it to something like '${parent}${child.slice(parent.length + 1).replace(/^./, c => c.toUpperCase())}'?`); }
			}
		}
		assert.deepStrictEqual(conflicts, []);
	});
});

// Folder-level .vscode/settings.json only applies to resource-scoped settings in a multi-root workspace, and
// unregistered keys (such as cpptools' C_Cpp.*) are dropped from workspace-level settings.
suite('package.json setting scopes', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
	const props = pkg.contributes.configuration.properties as Record<string, { scope?: string }>;

	test('per-project vscwclang settings are resource-scoped', () => {
		const wrong = ['flags', 'sourceGlobs', 'compileCommands', 'compileCommandsInclude', 'files.exclude', 'run.args', 'run.env', 'useCppToolsSettings']
			.filter(k => props[`vscwclang.${k}`]?.scope !== 'resource').map(k => `vscwclang.${k} needs "scope": "resource"`);
		assert.deepStrictEqual(wrong, []);
	});

	test('every C_Cpp setting the extension reads is registered', () => {
		const read = ['default.defines', 'default.includePath', 'default.compilerArgs', 'default.cppStandard', 'default.cStandard', 'default.compileCommands', 'files.exclude', 'loggingLevel', 'intelliSenseEngine'];
		assert.deepStrictEqual(read.filter(k => !props[`C_Cpp.${k}`]).map(k => `C_Cpp.${k} is read but not contributed`), []);
	});
});
