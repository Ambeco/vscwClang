/** The slice of `vscode.workspace.fs` that `removeStaleTempFiles` needs, so it can be tested without vscode. */
export interface TempDirFs<U> {
	readDirectory(dir: U): PromiseLike<[string, number][]>;
	stat(file: U): PromiseLike<{ mtime: number }>;
	delete(file: U): PromiseLike<void>;
	child(dir: U, name: string): U;
}

const BATCH = 16;

/**
 * Deletes files in clangd's `/tmp` mount older than `maxAgeMs`; returns how many went.
 *
 * clangd deletes its preamble files only on a clean exit, and a closed or reloaded tab never gives it one, so they
 * pile up in extension storage (200 files, 556 MB, made `createDirectory` on the folder take 1.2 s at every start).
 * Recent files are kept because another tab of the same profile may still be using them. Never throws.
 */
export async function removeStaleTempFiles<U>(fs: TempDirFs<U>, dir: U, now: number, maxAgeMs: number): Promise<number> {
	let entries: [string, number][];
	try { entries = await fs.readDirectory(dir); } catch { return 0; }
	let removed = 0;
	for (let i = 0; i < entries.length; i += BATCH) {
		const results: number[] = await Promise.all(entries.slice(i, i + BATCH).map(async ([name]): Promise<number> => {
			const file = fs.child(dir, name);
			try {
				if (now - (await fs.stat(file)).mtime < maxAgeMs) { return 0; }
				await fs.delete(file);
				return 1;
			} catch { return 0; }
		}));
		removed += results.reduce((a, b) => a + b, 0);
	}
	return removed;
}
