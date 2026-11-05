import * as assert from 'assert';
import { fingerprint, pullChanges, pushWorkspace, skipDefaultFolders, type FileTree } from '../../host/workspaceSync';

/** An in-memory folder: file paths map to bytes, folders are the set of their ancestors plus explicit ones. */
class MemTree implements FileTree {
	files = new Map<string, Uint8Array>();
	dirs = new Set<string>();
	constructor(files: Record<string, string> = {}, dirs: string[] = []) {
		for (const [p, text] of Object.entries(files)) { this.put(p, text); }
		for (const d of dirs) { this.dirs.add(d); }
	}
	put(path: string, text: string): void {
		this.files.set(path, new TextEncoder().encode(text));
		this.addParents(path);
	}
	text(path: string): string | undefined {
		const data = this.files.get(path);
		return data && new TextDecoder().decode(data);
	}
	private addParents(path: string): void {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) { this.dirs.add(parts.slice(0, i).join('/')); }
	}
	async readDir(path: string) {
		const prefix = path ? `${path}/` : '';
		if (path && !this.dirs.has(path)) { throw new Error(`no such folder ${path}`); }
		const out = new Map<string, boolean>();
		for (const f of this.files.keys()) { if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); const slash = rest.indexOf('/'); out.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0); } }
		for (const d of this.dirs) { if (d.startsWith(prefix) && d !== path) { const rest = d.slice(prefix.length); out.set(rest.split('/')[0], true); } }
		return [...out].map(([name, isDir]) => ({ name, isDir }));
	}
	async readFile(path: string) {
		const data = this.files.get(path);
		if (!data) { throw new Error(`no such file ${path}`); }
		return data;
	}
	async writeFile(path: string, data: Uint8Array) { this.files.set(path, data); this.addParents(path); }
	async remove(path: string) {
		this.files.delete(path);
		this.dirs.delete(path);
		for (const f of [...this.files.keys()]) { if (f.startsWith(`${path}/`)) { this.files.delete(f); } }
		for (const d of [...this.dirs]) { if (d.startsWith(`${path}/`)) { this.dirs.delete(d); } }
	}
	async mkdir(path: string) { this.dirs.add(path); this.addParents(`${path}/x`); }
}

const opts = { skip: skipDefaultFolders };

suite('workspaceSync', () => {
	test('fingerprint tells apart same-length content and differs by length', () => {
		assert.notStrictEqual(fingerprint(new TextEncoder().encode('abc')), fingerprint(new TextEncoder().encode('abd')));
		assert.notStrictEqual(fingerprint(new Uint8Array(3)), fingerprint(new Uint8Array(4)));
		assert.strictEqual(fingerprint(new TextEncoder().encode('abc')), fingerprint(new TextEncoder().encode('abc')));
	});

	test('skipDefaultFolders skips .git, node_modules and .vscwclang at any depth, and nothing else', () => {
		assert.ok(skipDefaultFolders('.git'));
		assert.ok(skipDefaultFolders('a/node_modules/x.js'));
		assert.ok(skipDefaultFolders('.vscwclang/debug/a.out.wasm'));
		assert.ok(!skipDefaultFolders('src/main.cpp'));
		assert.ok(!skipDefaultFolders('git/notes.txt'));
	});

	test('push copies files and folders (including empty ones) and skips the excluded folders', async () => {
		const host = new MemTree({ 'a.txt': 'A', 'src/b.cpp': 'B', '.git/HEAD': 'x', 'node_modules/p/i.js': 'y' }, ['empty']);
		const sandbox = new MemTree();
		const snap = await pushWorkspace(host, sandbox, opts);
		assert.deepStrictEqual([...snap.files.keys()].sort(), ['a.txt', 'src/b.cpp']);
		assert.ok(snap.dirs.has('empty') && snap.dirs.has('src'));
		assert.strictEqual(sandbox.text('src/b.cpp'), 'B');
		assert.ok(!sandbox.files.has('.git/HEAD'));
	});

	test('push refuses a workspace over the size limit and names the way out', async () => {
		const host = new MemTree({ 'big.bin': 'x'.repeat(100) });
		await assert.rejects(() => pushWorkspace(host, new MemTree(), { ...opts, maxBytes: 10 }), /vscwclang\.run\.host.*worker/);
	});

	test('pull writes only new and modified files and leaves unchanged ones alone', async () => {
		const host = new MemTree({ 'keep.txt': 'same', 'edit.txt': 'old' });
		const sandbox = new MemTree();
		const snap = await pushWorkspace(host, sandbox, opts);
		sandbox.put('edit.txt', 'new');
		sandbox.put('out/result.txt', 'R');
		const result = await pullChanges(host, sandbox, snap, opts);
		assert.deepStrictEqual(result.written, ['edit.txt', 'out/result.txt']);
		assert.strictEqual(host.text('edit.txt'), 'new');
		assert.strictEqual(host.text('out/result.txt'), 'R');
		assert.deepStrictEqual(result.deleted, []);
	});

	test('pull deletes a file the program removed, but not one the user edited meanwhile', async () => {
		const host = new MemTree({ 'gone.txt': 'g', 'edited.txt': 'e' });
		const sandbox = new MemTree();
		const snap = await pushWorkspace(host, sandbox, opts);
		await sandbox.remove('gone.txt');
		await sandbox.remove('edited.txt');
		host.put('edited.txt', 'user typed this');
		const result = await pullChanges(host, sandbox, snap, opts);
		assert.deepStrictEqual(result.deleted, ['gone.txt']);
		assert.deepStrictEqual(result.conflicts, ['edited.txt']);
		assert.strictEqual(host.text('edited.txt'), 'user typed this');
		assert.ok(!host.files.has('gone.txt'));
	});

	test('pull keeps the user\'s edit when both sides changed a file', async () => {
		const host = new MemTree({ 'f.txt': 'orig' });
		const sandbox = new MemTree();
		const snap = await pushWorkspace(host, sandbox, opts);
		sandbox.put('f.txt', 'program');
		host.put('f.txt', 'user');
		const result = await pullChanges(host, sandbox, snap, opts);
		assert.deepStrictEqual(result.conflicts, ['f.txt']);
		assert.strictEqual(host.text('f.txt'), 'user');
	});

	test('pull creates new empty folders and removes emptied folders the program deleted', async () => {
		const host = new MemTree({ 'old/a.txt': 'a' });
		const sandbox = new MemTree();
		const snap = await pushWorkspace(host, sandbox, opts);
		await sandbox.remove('old');
		await sandbox.mkdir('fresh/inner');
		await pullChanges(host, sandbox, snap, opts);
		assert.ok(!host.dirs.has('old'));
		assert.ok(host.dirs.has('fresh/inner'));
	});

	test('pull does not treat skipped folders as deleted', async () => {
		const host = new MemTree({ '.git/HEAD': 'h', 'a.txt': 'a' });
		const sandbox = new MemTree();
		const snap = await pushWorkspace(host, sandbox, opts);
		await pullChanges(host, sandbox, snap, opts);
		assert.strictEqual(host.text('.git/HEAD'), 'h');
	});
});
