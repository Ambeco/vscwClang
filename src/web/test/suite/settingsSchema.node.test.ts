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
