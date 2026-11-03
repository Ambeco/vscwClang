import { splitFlags } from './flagPolicy';
import { GUEST_WORKSPACE, stripWorkspaceFolder } from './guestPaths';
import { isCompilerTask, planFromTask } from './projectModel';

/** One `tasks.json` build: the sources it compiles (workspace-relative files or globs) and the flags it compiles them with. */
export interface IndexTarget {
	label: string;
	sources: string[];
	flags: string[];
}

/**
 * The builds `tasks.json` describes, for the background indexer: every g++/clang++ task and every `vscwclang` task,
 * with the flags they would compile with, so indexed files see the same macros and include paths as a real build.
 *
 * A `vscwclang` task without `sources` builds `defaultSources`. A task that cannot be resolved without an editor
 * (`${file}`, `${input:...}`) or that the sandbox cannot build is skipped with a note, so it never decides what is
 * indexed.
 */
export function indexTargetsFromTasks(tasks: unknown, folderName: string, defaultSources: readonly string[]): { targets: IndexTarget[]; notes: string[] } {
	const targets: IndexTarget[] = [];
	const notes: string[] = [];
	if (!Array.isArray(tasks)) { return { targets, notes }; }
	for (const raw of tasks as Record<string, unknown>[]) {
		if (raw === null || typeof raw !== 'object') { continue; }
		const label = typeof raw.label === 'string' ? raw.label : String(raw.command ?? raw.type);
		try {
			if (raw.type === 'vscwclang') {
				const sources = Array.isArray(raw.sources) ? raw.sources.map(s => stripWorkspaceFolder(String(s))) : [...defaultSources];
				const flags = splitFlags(Array.isArray(raw.flags) ? raw.flags.map(String) : [], GUEST_WORKSPACE).compile;
				targets.push({ label, sources, flags });
			} else if (isCompilerTask(raw)) {
				const plan = planFromTask(raw, { folderName });
				targets.push({ label, sources: plan.sources, flags: splitFlags(plan.flags, GUEST_WORKSPACE).compile });
			}
		} catch (e) {
			notes.push(`not indexing task '${label}': ${(e as Error).message}`);
		}
	}
	return { targets, notes };
}
