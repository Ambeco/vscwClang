import { GUEST_WORKSPACE } from '../toolchain/guestPaths';

export const GUEST_CACHE = '/cache';
/** Where clangd's user config lives (`XDG_CONFIG_HOME`), so `/config/clangd/config.yaml` is read. */
export const GUEST_CONFIG = '/config';

/**
 * Where clangd writes index shards for a compilation database in `databaseDir` (workspace-relative, '' for the
 * root): `<root>/.cache/clangd`. Mounting extension storage there keeps shards out of the user's folder and works
 * when the folder is read-only. Undefined when the database lies outside the workspace.
 */
export function shardMountPoint(databaseDir: string): string | undefined {
	if (databaseDir.startsWith('/') || databaseDir.split('/').includes('..')) { return undefined; }
	const dir = databaseDir.split('/').filter(part => part !== '' && part !== '.').join('/');
	return `${GUEST_WORKSPACE}${dir ? '/' + dir : ''}/.cache/clangd`;
}

/** Worker threads for clangd's parser pool and background indexer: most cores, but each is a Worker with its own stack. */
export function clangdThreadCount(hardwareConcurrency: number | undefined): number {
	return Math.max(2, Math.min(4, (hardwareConcurrency ?? 4) - 1));
}

/** Above this many lines semantic tokens are skipped: clangd takes ~0.23 ms per line (wasm) to compute them on every edit. */
export const SEMANTIC_TOKENS_MAX_LINES = 10_000;

/** clangd's startup arguments; its real background indexer needs the threaded build. */
export function clangdArgs(logLevel: string, jobs: number, extra: readonly string[] = []): string[] {
	return ['-background-index', `-j=${jobs}`, '-resource-dir=/resource', `-log=${logLevel}`, ...extra];
}

export interface CompilationDatabaseChanges {
	[guestPath: string]: { workingDirectory: string; compilationCommand: string[] };
}

/** Sources per `workspace/didChangeConfiguration`, so a large project does not become one huge message. */
export const OVERLAY_BATCH_SIZE = 200;

/**
 * Per-file compile commands for clangd's `workspace/didChangeConfiguration` `compilationDatabaseChanges`, which
 * is how clangd's background indexer learns of files when the project has no `compile_commands.json`.
 * `perFileFlags` (keyed by guest path) follow the shared `flags`, so a task's own `-D`/`-I`/`-std` win.
 */
export function compilationDatabaseChanges(guestPaths: readonly string[], flags: readonly string[], perFileFlags: Readonly<Record<string, readonly string[]>> = {}): CompilationDatabaseChanges {
	const changes: CompilationDatabaseChanges = {};
	for (const guestPath of guestPaths) {
		const driver = guestPath.toLowerCase().endsWith('.c') ? 'clang' : 'clang++';
		changes[guestPath] = { workingDirectory: GUEST_WORKSPACE, compilationCommand: [driver, ...flags, ...(perFileFlags[guestPath] ?? []), guestPath] };
	}
	return changes;
}

/** Splits `items` into consecutive slices of at most `size`. */
export function batches<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) { out.push(items.slice(i, i + size)); }
	return out;
}
