import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Keeps documents/design.md "Layout" and documents/helpers.md in step with the code. Runs from the repo root
// (`npm run test-node`). A "helper" is an exported function, class or const whose JSDoc block contains `@helper`.

const ROOT = process.cwd();
const HELPERS_LINE_CAP = 150;
const HELPERS_FILE = 'documents/helpers.md';
const DESIGN_FILE = 'documents/design.md';

interface TreeLine { line: number; text: string; depth: number; raw: string }
// `path` is the full path for folders and files; `file` is the enclosing file's path for names below it.
interface TreeEntry extends TreeLine { isFolder: boolean; isFile: boolean; path: string; file: string | undefined }

function read(relative: string): string {
	return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

// Lines of the first fenced block after `heading` (or of the whole file's first fence when heading is undefined).
// Two spaces of indent per level; ` # ...` starts a comment.
function readTree(relative: string, heading?: string): TreeLine[] {
	const lines = read(relative).split('\n');
	let i = 0;
	if (heading) {
		i = lines.findIndex(l => l.trim() === heading);
		assert.ok(i >= 0, `${relative} has no "${heading}" heading. Add a "${heading}" section with a fenced tree of the main folders.`);
	}
	while (i < lines.length && !lines[i].startsWith('```')) { i++; }
	assert.ok(i < lines.length, `${relative} has no fenced block${heading ? ` after "${heading}"` : ''}; the tree goes in a \`\`\` fence.`);
	const out: TreeLine[] = [];
	for (let n = i + 1; n < lines.length && !lines[n].startsWith('```'); n++) {
		const raw = lines[n];
		const text = raw.replace(/\s+#.*$/, '').trim();
		if (!text) { continue; }
		const indent = raw.length - raw.trimStart().length;
		assert.strictEqual(indent % 2, 0, `${relative}:${n + 1}: indent must be a multiple of 2 spaces: "${raw}"`);
		out.push({ line: n + 1, text, depth: indent / 2, raw });
	}
	return out;
}

// Folder lines end in `/`, file lines have an extension, anything else is a name below the nearest file.
function resolveTree(relative: string, lines: TreeLine[]): TreeEntry[] {
	const stack: string[] = [];
	let file: string | undefined;
	return lines.map(l => {
		stack.length = Math.min(stack.length, l.depth);
		assert.ok(l.depth <= stack.length, `${relative}:${l.line}: indented too deep under its parent: "${l.raw}"`);
		const isFolder = l.text.endsWith('/');
		const isFile = !isFolder && /^[\w.-]+\.\w+$/.test(l.text);
		if (isFolder || isFile) { stack[l.depth] = l.text; }
		if (isFolder) { file = undefined; }
		if (isFile) { file = stack.join(''); }
		return { ...l, isFolder, isFile, path: stack.join('').replace(/\/$/, ''), file };
	});
}

function listSources(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
		const rel = `${dir}/${e.name}`;
		if (e.isDirectory()) { if (e.name !== 'test') { listSources(rel, out); } }
		else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) { out.push(rel); }
	}
	return out;
}

function taggedHelpers(): Map<string, string[]> {
	const re = /\/\*\*(?:(?!\*\/)[\s\S])*?@helper(?:(?!\*\/)[\s\S])*?\*\/\s*export\s+(?:async\s+)?(?:function\*?|const|class|let)\s+(\w+)/g;
	const found = new Map<string, string[]>();
	for (const file of listSources('src')) {
		const names = [...read(file).matchAll(re)].map(m => m[1]);
		if (names.length) { found.set(file, names); }
	}
	return found;
}

function patternToRegExp(pattern: string): RegExp {
	return new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

// The lines to add to helpers.md for a helper in `file`, creating parent folders as needed.
function suggestedLines(file: string, name: string): string {
	const parts = file.split('/');
	const lines = parts.slice(0, -1).map((p, i) => `${'  '.repeat(i)}${p}/`);
	lines.push(`${'  '.repeat(parts.length - 1)}${parts[parts.length - 1]}`, `${'  '.repeat(parts.length)}${name}`);
	return lines.join('\n');
}

suite('code map', () => {
	test('every path in the design.md Layout tree exists', () => {
		const entries = resolveTree(DESIGN_FILE, readTree(DESIGN_FILE, '## Layout'));
		assert.ok(entries.length > 0, `${DESIGN_FILE} "## Layout" tree is empty.`);
		const stale = entries.filter(e => (e.isFile || e.isFolder) && !fs.existsSync(path.join(ROOT, e.path)))
			.map(e => `${DESIGN_FILE}:${e.line}: remove the line "${e.raw.trim()}" (${e.path} no longer exists)`);
		assert.deepStrictEqual(stale, []);
	});
});

suite('helper registry', () => {
	const registry = (): TreeEntry[] => resolveTree(HELPERS_FILE, readTree(HELPERS_FILE));

	test('every @helper is listed under its file in helpers.md', () => {
		const names = registry().filter(e => !e.isFolder && !e.isFile);
		const missing: string[] = [];
		for (const [file, helpers] of taggedHelpers()) {
			const patterns = names.filter(e => e.file === file).map(e => patternToRegExp(e.text));
			for (const h of helpers) {
				if (!patterns.some(p => p.test(h))) {
					missing.push(`${file} tags "${h}" @helper. Add to ${HELPERS_FILE} (merging with existing parent lines):\n${suggestedLines(file, h)}`);
				}
			}
		}
		assert.deepStrictEqual(missing, []);
	});

	test('every helpers.md entry matches a @helper in its file', () => {
		const tagged = taggedHelpers();
		const extra: string[] = [];
		for (const e of registry()) {
			if (e.isFolder || e.isFile) { continue; }
			const re = patternToRegExp(e.text);
			if (!e.file) { extra.push(`${HELPERS_FILE}:${e.line}: remove "${e.raw.trim()}" or move it under a file line (names must sit below a .ts file).`); }
			else if (!(tagged.get(e.file) ?? []).some(h => re.test(h))) {
				const hint = fs.existsSync(path.join(ROOT, e.file)) ? `nothing tagged @helper in ${e.file} matches` : `${e.file} does not exist`;
				extra.push(`${HELPERS_FILE}:${e.line}: remove the line "${e.raw.trim()}" (${hint})`);
			}
		}
		assert.deepStrictEqual(extra, []);
	});

	test('helpers.md stays within its line cap', () => {
		const count = read(HELPERS_FILE).replace(/\n$/, '').split('\n').length;
		assert.ok(count <= HELPERS_LINE_CAP,
			`${HELPERS_FILE} has ${count} lines, over the cap of ${HELPERS_LINE_CAP}. Merge similar names into patterns (make_foo*), prune, or split by subtree.`);
	});
});
