import { GUEST_WORKSPACE } from '../toolchain/guestPaths';
import { hostToGuest } from '../toolchain/projectModel';
import { ClassifyError, classifyShellLine } from './classify';
import { BuildGraph, BuildGraphError } from './graph';
import { ShellSyntaxError } from './shellParse';

/**
 * Reads the output of `make -n -B --trace <goal>` into a build graph. Vscode-free.
 *
 * GNU make's dry run prints every recipe line that would run, each batch preceded by
 * `Makefile:LINE: update target 'T' due to: REASON`, so each command is attributed to its target; recursive makes
 * add `make[N]: Entering directory` lines that set the directory its commands run in. `-B` matters: without it,
 * targets that are up to date print nothing, and the graph would lack the steps that produce files a link reads
 * (`parseMakeTrace` reports this as `complete: false`, and lowering then fails on the unproduced object).
 *
 * `buildGraphFromMake` refuses output a dry run cannot make trustworthy, with a did-you-mean: commands that ran
 * before any target (make remaking an included makefile that a recipe generates, which a dry run prints but does not
 * run), warnings and errors (`$(shell ...)` needs a process, so it expands to nothing; a recursive `$(MAKE)` line
 * fails with status 127). Recursive `make` command lines are skipped, since the sub-make's own recipes follow them.
 * Host directories in `Entering directory` lines are rebased with `hostRoot`, or the first top-level `make:` one is taken as the root.
 */
export class MakeTraceError extends Error {}

export interface MakeRecipe {
	target: string;
	reason: string;
	makefile: string;
	line: number;
	/** Guest directory the recipe runs in. */
	cwd: string;
	commands: string[];
}

export interface MakeTrace {
	recipes: MakeRecipe[];
	/** Command lines printed before any target header. */
	preamble: string[];
	/** `Nothing to be done` and similar status lines. */
	messages: string[];
	/** Warnings and `***` errors, verbatim. */
	problems: string[];
	/** Every recipe ran because its target did not exist or is phony, as `-B` makes it. */
	complete: boolean;
}

const HEADER = /^(.+?):(\d+): update target '(.+)' due to: (.*)$/;
const DIRECTORY = /^make(\[\d+\])?: (Entering|Leaving) directory '(.*)'$/;
const MAKE_ERROR = /^make(?:\[\d+\])?: \*\*\* /;
const MAKE_STATUS = /^make(?:\[\d+\])?: (Nothing to be done|'.*' is up to date|Entering|Leaving)/;
const MAKE_WARNING = /^[^\s:'"]+:\d+: \S/;
const MAKE_PROGRAM = /^(g?make)(\.exe)?$/;

/** @helper Parses `make -n -B --trace` output into recipes with their directories; never throws on odd lines, it lists them in `problems`. */
export function parseMakeTrace(text: string, hostRoot?: string): MakeTrace {
	const trace: MakeTrace = { recipes: [], preamble: [], messages: [], problems: [], complete: true };
	let root = hostRoot;
	const stack: string[] = [GUEST_WORKSPACE];
	let current: MakeRecipe | undefined;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (line.trim() === '') { continue; }
		const header = HEADER.exec(line);
		const directory = DIRECTORY.exec(line);
		if (header) {
			current = { target: header[3], reason: header[4], makefile: header[1], line: Number(header[2]), cwd: stack[stack.length - 1], commands: [] };
			trace.recipes.push(current);
			if (header[4] !== 'target does not exist' && header[4] !== 'target is .PHONY') { trace.complete = false; }
		} else if (directory) {
			if (directory[2] === 'Leaving') {
				if (stack.length > 1) { stack.pop(); }
			} else {
				if (directory[1] === undefined) { root ??= directory[3]; }
				stack.push(root === undefined ? directory[3] : hostToGuest(directory[3], GUEST_WORKSPACE, root) ?? directory[3]);
			}
			current = undefined;
		} else if (MAKE_ERROR.test(line)) {
			trace.problems.push(line);
		} else if (MAKE_STATUS.test(line)) {
			trace.messages.push(line);
		} else if (MAKE_WARNING.test(line)) {
			trace.problems.push(line);
		} else if (current === undefined) {
			trace.preamble.push(line);
		} else {
			current.commands.push(line);
		}
	}
	return trace;
}

function describeProblem(problem: string): string {
	if (/Function not implemented/.test(problem)) {
		return `\`${problem}\`: a \`$(shell ...)\` ran, but the browser cannot start a process, so it expanded to nothing. Did you mean to replace it with a plain value in the Makefile (or to pass it as a variable, e.g. \`make NAME=value\`)?`;
	}
	if (/Error 127/.test(problem)) {
		return `\`${problem}\`: a recipe line needed a program the browser cannot run (status 127, command not found). Did you mean to build the sub-directory's target directly, or to run make there?`;
	}
	return `\`${problem}\`. Did you mean to fix this in the Makefile and run the dry run again?`;
}

/** @helper Builds a graph from `make -n -B --trace` output; throws `MakeTraceError` (with a did-you-mean) when the output cannot be trusted or a command cannot be mapped. */
export function buildGraphFromMake(text: string, hostRoot?: string): { graph: BuildGraph; notes: string[]; trace: MakeTrace } {
	const trace = parseMakeTrace(text, hostRoot);
	if (trace.problems.length > 0) {
		throw new MakeTraceError(`vscwClang: make's dry run reported ${trace.problems.length} problem${trace.problems.length === 1 ? '' : 's'}: ${trace.problems.map(describeProblem).join(' ')}`);
	}
	if (trace.preamble.length > 0) {
		throw new MakeTraceError(`vscwClang: make ran \`${trace.preamble[0]}\` before any target, which is how it remakes an included makefile; a dry run prints that but does not run it, so everything after it may be wrong. Did you mean to commit the generated include file, or to remove the rule that makes it?`);
	}
	const graph = new BuildGraph();
	const notes: string[] = [];
	for (const recipe of trace.recipes) {
		for (const command of recipe.commands) {
			const firstWord = /^\s*(?:"([^"]+)"|(\S+))/.exec(command);
			const program = ((firstWord?.[1] ?? firstWord?.[2] ?? '').replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
			if (MAKE_PROGRAM.test(program)) {
				notes.push(`skipped the recursive make line of target '${recipe.target}': its own recipes follow`);
				continue;
			}
			try {
				const classified = classifyShellLine(command, { cwd: recipe.cwd, hostRoot });
				notes.push(...classified.notes);
				classified.actions.forEach(a => graph.addNode(a, recipe.target));
			} catch (e) {
				if (e instanceof ClassifyError || e instanceof ShellSyntaxError || e instanceof BuildGraphError) {
					throw new MakeTraceError(`In the recipe for target '${recipe.target}' (${recipe.makefile}:${recipe.line}): ${e.message}`);
				}
				throw e;
			}
		}
	}
	if (!trace.complete) {
		notes.push('the dry run was not made with -B: targets that were up to date are missing, so steps that produce files the link reads may be absent');
	}
	return { graph, notes, trace };
}
