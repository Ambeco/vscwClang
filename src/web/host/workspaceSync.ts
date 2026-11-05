/** A folder as the sync sees it: paths are relative to its root, `/`-separated, with `''` for the root. */
export interface FileTree {
	readDir(path: string): Promise<{ name: string; isDir: boolean }[]>;
	readFile(path: string): Promise<Uint8Array>;
	/** Creates missing parent folders. */
	writeFile(path: string, data: Uint8Array): Promise<void>;
	/** Removes a file, or a folder and everything in it. */
	remove(path: string): Promise<void>;
	/** Creates the folder and any missing parents; succeeds if it exists. */
	mkdir(path: string): Promise<void>;
}

/** What was copied in: file fingerprints, and the folders (so a deleted folder can be told from one never copied). */
export interface WorkspaceSnapshot {
	files: Map<string, string>;
	dirs: Set<string>;
}

export interface SyncResult {
	written: string[];
	deleted: string[];
	/** Changed on both sides during the run; the host copy was left alone. */
	conflicts: string[];
}

export interface SyncOptions {
	/** True for a relative path that is neither copied in nor copied back. */
	skip: (path: string) => boolean;
	/** Copy-in refuses a workspace bigger than this many bytes, with a message naming the way out. */
	maxBytes?: number;
	concurrency?: number;
}

/** Folders never copied: version control, dependencies and this extension's own build output. */
export const DEFAULT_SYNC_SKIPS = ['.git', 'node_modules', '.vscwclang'];

export const DEFAULT_SYNC_MAX_BYTES = 256 * 1024 * 1024;

/** @helper Skip predicate for the folders in `DEFAULT_SYNC_SKIPS` at any depth. */
export function skipDefaultFolders(path: string): boolean {
	return path.split('/').some(part => DEFAULT_SYNC_SKIPS.includes(part));
}

/**
 * Content fingerprint for change detection: length plus two independent 32-bit hashes. Not cryptographic; a
 * collision would need a same-length edit that leaves both hashes unchanged.
 */
export function fingerprint(data: Uint8Array): string {
	let a = 0x811c9dc5, b = 5381;
	for (let i = 0; i < data.length; i++) {
		a = Math.imul(a ^ data[i], 0x01000193);
		b = (Math.imul(b, 33) + data[i]) | 0;
	}
	return `${data.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) { await fn(items[next++]); }
	}));
}

/** Lists every file and folder under the root that `skip` does not exclude. */
async function walk(tree: FileTree, skip: (path: string) => boolean): Promise<{ files: string[]; dirs: string[] }> {
	const files: string[] = [], dirs: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await tree.readDir(dir)) {
			const path = join(dir, entry.name);
			if (skip(path)) { continue; }
			if (entry.isDir) { dirs.push(path); await visit(path); } else { files.push(path); }
		}
	};
	await visit('');
	return { files, dirs };
}

/**
 * Copies the host folder into the sandbox and returns what it copied.
 *
 * Files are read whole into memory, so a very large workspace is refused up front with the way to narrow it.
 */
export async function pushWorkspace(host: FileTree, sandbox: FileTree, options: SyncOptions): Promise<WorkspaceSnapshot> {
	const { files, dirs } = await walk(host, options.skip);
	const snapshot: WorkspaceSnapshot = { files: new Map(), dirs: new Set(dirs) };
	let total = 0;
	await forEachLimited(files, options.concurrency ?? 8, async path => {
		const data = await host.readFile(path);
		total += data.length;
		if (total > (options.maxBytes ?? DEFAULT_SYNC_MAX_BYTES)) {
			throw new Error(`vscwClang: the workspace is over ${Math.round((options.maxBytes ?? DEFAULT_SYNC_MAX_BYTES) / 1048576)} MB, too much to copy into the Wasmer sandbox for each run. Did you mean to open a smaller folder, or to set vscwclang.run.host to "worker" (which reads files on demand)?`);
		}
		snapshot.files.set(path, fingerprint(data));
		await sandbox.writeFile(path, data);
	});
	return snapshot;
}

/**
 * Copies what the program changed back to the host: new and modified files are written, files it removed are
 * deleted. A file the user also edited during the run (its host copy no longer matches the snapshot) is a conflict
 * and is left alone, in both directions.
 */
export async function pullChanges(host: FileTree, sandbox: FileTree, snapshot: WorkspaceSnapshot, options: SyncOptions): Promise<SyncResult> {
	const result: SyncResult = { written: [], deleted: [], conflicts: [] };
	const now = await walk(sandbox, options.skip);
	const present = new Set(now.files);
	const hostUnchanged = async (path: string, before: string): Promise<boolean> => {
		try { return fingerprint(await host.readFile(path)) === before; } catch { return false; }
	};
	await forEachLimited(now.files, options.concurrency ?? 8, async path => {
		const data = await sandbox.readFile(path);
		const before = snapshot.files.get(path);
		if (before === fingerprint(data)) { return; }
		if (before !== undefined && !await hostUnchanged(path, before)) { result.conflicts.push(path); return; }
		await host.writeFile(path, data);
		result.written.push(path);
	});
	for (const [path, before] of snapshot.files) {
		if (present.has(path)) { continue; }
		if (await hostUnchanged(path, before)) { await host.remove(path); result.deleted.push(path); } else { result.conflicts.push(path); }
	}
	const stillThere = new Set(now.dirs);
	const gone = [...snapshot.dirs].filter(d => !stillThere.has(d)).sort((x, y) => y.length - x.length);
	for (const dir of gone) {
		try { if ((await host.readDir(dir)).length === 0) { await host.remove(dir); } } catch { /* already gone */ }
	}
	for (const dir of now.dirs) {
		if (snapshot.dirs.has(dir)) { continue; }
		await host.mkdir(dir);
	}
	result.written.sort(); result.deleted.sort(); result.conflicts.sort();
	return result;
}
