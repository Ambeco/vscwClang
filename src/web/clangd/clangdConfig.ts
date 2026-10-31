import { GUEST_WORKSPACE } from '../toolchain/guestPaths';

export const GUEST_CACHE = '/cache';

/** Worker threads for clangd's parser pool and background indexer: most cores, but each is a Worker with its own stack. */
export function clangdThreadCount(hardwareConcurrency: number | undefined): number {
	return Math.max(2, Math.min(4, (hardwareConcurrency ?? 4) - 1));
}

/** clangd's startup arguments; its real background indexer needs the threaded build. */
export function clangdArgs(logLevel: string, jobs: number): string[] {
	return ['-background-index', `-j=${jobs}`, '-resource-dir=/resource', `-log=${logLevel}`];
}

export interface CompilationDatabaseChanges {
	[guestPath: string]: { workingDirectory: string; compilationCommand: string[] };
}

/** Sources per `workspace/didChangeConfiguration`, so a large project does not become one huge message. */
export const OVERLAY_BATCH_SIZE = 200;

/**
 * Per-file compile commands for clangd's `workspace/didChangeConfiguration` `compilationDatabaseChanges`, which
 * is how clangd's background indexer learns of files when the project has no `compile_commands.json`.
 */
export function compilationDatabaseChanges(guestPaths: readonly string[], flags: readonly string[]): CompilationDatabaseChanges {
	const changes: CompilationDatabaseChanges = {};
	for (const guestPath of guestPaths) {
		const driver = guestPath.toLowerCase().endsWith('.c') ? 'clang' : 'clang++';
		changes[guestPath] = { workingDirectory: GUEST_WORKSPACE, compilationCommand: [driver, ...flags, guestPath] };
	}
	return changes;
}

/** Splits `items` into consecutive slices of at most `size`. */
export function batches<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) { out.push(items.slice(i, i + size)); }
	return out;
}
