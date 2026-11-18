import { GUEST_WORKSPACE } from '../toolchain/guestPaths';
import { hostToGuest } from '../toolchain/projectModel';
import { ClassifyError, classifyShellLine } from './classify';
import { BuildGraph, BuildGraphError } from './graph';
import { expandCommand, NinjaParseError, type NinjaEdge, type NinjaManifest } from './ninjaParse';
import { ShellSyntaxError } from './shellParse';

/**
 * Turns a parsed Ninja manifest into a build graph. Vscode-free.
 *
 * Only the edges the goals need are classified: everything reachable through inputs, implicit inputs and order-only
 * inputs, with `phony` edges as aliases (so a CMake target name such as `format-test` or `all` is a goal). The rest
 * of a CMake manifest (cache editors, `RERUN_CMAKE`, install, test and package utilities) is never looked at, so its
 * commands need no mapping. Edges are added dependencies first whatever their order in the file. A reachable edge
 * with `generator = 1` (CMake re-running itself) or a command the classifier cannot map throws
 * `NinjaTraceError` naming the edge, with a did-you-mean.
 *
 * Commands run in `buildDir`, which must be inside the workspace; `hostRoot` is the host path of the workspace folder,
 * used to rebase absolute host paths a generator wrote. A Windows `cmd.exe /C "..."` wrapper is removed and its
 * backslashes read as separators. Dependency edges the graph needs come from the commands themselves (`-o`, inputs),
 * so a Ninja input the command does not name (a generated header) is only ordering: lowering then fails on it if
 * it is a source.
 */
export class NinjaTraceError extends Error {}

export interface NinjaGraphOptions {
	/** Host or guest path of the directory Ninja runs in (where `build.ninja` is). */
	buildDir: string;
	hostRoot?: string;
	/** Targets (names or paths relative to `buildDir`); default: the manifest's `default` targets, else `all`. */
	goals?: string[];
}

export interface NinjaGraph {
	graph: BuildGraph;
	notes: string[];
	/** The non-phony guest paths the goals stand for. */
	goalOutputs: string[];
}

const WINDOWS_PATH = /(^|[\s"'=-])[A-Za-z]:\\/;
const CMD_WRAPPER = /^\s*(?:"[^"]*cmd(?:\.exe)?"|\S*cmd(?:\.exe)?)\s+\/[cC]\s+"(.*)"\s*$/;

// The POST_BUILD step of gtest_discover_tests: `[cd DIR &&] cmake -D TEST_TARGET=... -P GoogleTestAddTests.cmake`, on Windows inside `cmd.exe /C "..."`.
const GTEST_DISCOVERY = /\s*&&\s*(?:(?:"[^"]*"|[^\s"&]*)cmd(?:\.exe)?"?\s+\/[cC]\s+")?(?:cd\s[^&]*&&\s*)?(?:"[^"]*[\\/]cmake(?:\.exe)?"|[^\s"&]*cmake(?:\.exe)?)\s+-D\s+TEST_TARGET=[^]*GoogleTestAddTests\.cmake[^]*$/;

/** @helper Builds a graph from the edges `goals` need in a parsed `build.ninja`; throws `NinjaTraceError` (with a did-you-mean) for unknown goals and commands that cannot be mapped. */
export function buildGraphFromNinja(manifest: NinjaManifest, options: NinjaGraphOptions): NinjaGraph {
	const cwd = hostToGuest(options.buildDir, GUEST_WORKSPACE, options.hostRoot ?? '/\0no-host-root');
	if (cwd === undefined) {
		throw new NinjaTraceError(`vscwClang: the build directory '${options.buildDir}' is outside the workspace folder, which is all a browser build can see. Did you mean to open the folder that contains it?`);
	}
	const key = (p: string) => hostToGuest(p, cwd, options.hostRoot ?? '/\0no-host-root') ?? p;
	const producers = new Map<string, NinjaEdge>();
	for (const edge of manifest.edges) {
		for (const out of [...edge.outputs, ...edge.implicitOutputs]) { producers.set(key(out), edge); }
	}
	const requested = options.goals ?? (manifest.defaults.length > 0 ? manifest.defaults : ['all']);
	const goalKeys = requested.map(g => {
		const k = key(g);
		if (!producers.has(k)) { throw unknownGoal(g, producers, cwd); }
		return k;
	});

	const ordered: NinjaEdge[] = [];
	const state = new Map<NinjaEdge, 'visiting' | 'done'>();
	const goalOutputs = new Set<string>();
	const visit = (edge: NinjaEdge, trail: NinjaEdge[]) => {
		if (state.get(edge) === 'done') { return; }
		if (state.get(edge) === 'visiting') {
			throw new NinjaTraceError(`vscwClang: ${edge.where}: Ninja edges depend on each other in a cycle through '${edge.outputs[0]}'. Did you mean to regenerate the build directory?`);
		}
		state.set(edge, 'visiting');
		for (const input of [...edge.inputs, ...edge.implicitInputs, ...edge.orderOnlyInputs]) {
			const producer = producers.get(key(input));
			if (producer !== undefined) { visit(producer, [...trail, edge]); }
		}
		state.set(edge, 'done');
		ordered.push(edge);
	};
	const resolveGoal = (k: string) => {
		const edge = producers.get(k) as NinjaEdge;
		visit(edge, []);
		if (edge.rule !== 'phony') { goalOutputs.add(k); return; }
		for (const input of [...edge.inputs, ...edge.implicitInputs]) {
			const ik = key(input);
			if (producers.has(ik)) { resolveGoal(ik); }
		}
	};
	goalKeys.forEach(resolveGoal);

	const graph = new BuildGraph();
	const notes: string[] = [];
	for (const edge of ordered) {
		if (edge.rule === 'phony') { continue; }
		const rule = manifest.rules.get(edge.rule);
		if (rule?.bindings.generator === '1' || edge.bindings.generator === '1') {
			throw new NinjaTraceError(`vscwClang: ${edge.where}: the goal needs '${edge.outputs[0]}', which only CMake re-running itself makes. Did you mean to regenerate the build directory on a desktop and open that, or to name a target (such as 'all') instead of this file?`);
		}
		let command = expandCommand(manifest, edge);
		if (GTEST_DISCOVERY.test(command)) {
			command = command.replace(GTEST_DISCOVERY, '');
			if (command.split('"').length % 2 === 0) { command += '"'; } // the cut took the closing quote of an outer cmd.exe /C wrapper
			notes.push(`${edge.where}: skipped the gtest_discover_tests step after linking '${edge.outputs[0]}' (it only writes CTest lists, which a browser build does not use).`);
		}
		const wrapped = CMD_WRAPPER.exec(command);
		if (wrapped !== null) { command = wrapped[1]; }
		if (wrapped !== null || WINDOWS_PATH.test(command)) { command = command.replace(/\\(?!["'\s])/g, '/'); }
		try {
			const classified = classifyShellLine(command, { cwd, hostRoot: options.hostRoot });
			notes.push(...classified.notes);
			classified.actions.forEach(a => graph.addNode(a, edge.outputs[0]));
		} catch (e) {
			if (e instanceof ClassifyError || e instanceof ShellSyntaxError || e instanceof BuildGraphError || e instanceof NinjaParseError) {
				throw new NinjaTraceError(`In the build step for '${edge.outputs[0]}' (${edge.where}): ${e.message}`);
			}
			throw e;
		}
	}
	return { graph, notes, goalOutputs: [...goalOutputs] };
}

function unknownGoal(goal: string, producers: Map<string, NinjaEdge>, cwd: string): NinjaTraceError {
	const names = [...producers.keys()];
	const base = goal.replace(/^.*\//, '');
	const close = names.filter(n => { const nb = n.replace(/^.*\//, ''); return nb.includes(base) || (nb.length >= 3 && base.includes(nb)); }).slice(0, 5);
	const shown = (close.length > 0 ? close : names.filter(n => !n.includes('/CMakeFiles/') && !n.startsWith('CMakeFiles/')).slice(0, 8)).map(n => `'${n.replace(`${cwd}/`, '').replace(`${GUEST_WORKSPACE}/`, '')}'`).join(', ');
	return new NinjaTraceError(`vscwClang: the Ninja manifest has no target '${goal}'. Did you mean ${shown || 'a target listed by `ninja -t targets`'}?`);
}
