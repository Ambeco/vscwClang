import { GUEST_WORKSPACE } from '../toolchain/guestPaths';
import { SOURCE_EXTENSION } from '../toolchain/projectModel';
import type { BuildAction } from './classify';
import type { BuildGraph, GraphNode } from './graph';

/**
 * Lowers one program of a build graph onto what `toolchain.build()` takes, so the core's compile, cache and link code
 * is reused and the extension needs no archive or process model. Vscode-free.
 *
 * The goal must be produced by a `link` node. Every source reachable from it (directly, through an object, or
 * through a static library) is compiled by the core with the flags of the step that compiled it (`sourceFlags`, keyed
 * by guest path); a static library is folded into the program, its `-l<name>` flag dropped, because lowering has no
 * archive step. Of the link line only `-l`, `-L`, `-Wl,` and `-pthread` reach `flags`; other flags apply to the
 * sources named on the link line itself. Object file names are chosen by the core, not by the build.
 *
 * Anything lowering cannot express throws `LowerError` naming the step: a generated source (a `write`, `copy`,
 * `move` or `touch` that makes an input), a prebuilt object or archive nothing builds, a source compiled twice with
 * different flags, or a goal that is not a program. `mkdir`, `rm` and no-op steps are not part of a program build.
 */
export class LowerError extends Error {}

export interface LoweredBuild {
	/** Workspace-relative sources, in link order. */
	sources: string[];
	/** Guest source path -> its own flags. */
	sourceFlags: Record<string, string[]>;
	/** Link-only flags, for `BuildRequest.flags`. */
	flags: string[];
	/** Workspace-relative output path (the linked program). */
	output: string;
	mode: 'debug' | 'release';
	notes: string[];
}

const LINK_FLAG = /^(-l.+|-L.*|-Wl,.*|-pthread)$/;
const toRelative = (guest: string) => guest.startsWith(`${GUEST_WORKSPACE}/`) ? guest.slice(GUEST_WORKSPACE.length + 1) : guest;

/** @helper Lowers the program `goal` (a guest path) of `graph` onto the inputs of `toolchain.build()`; throws `LowerError` for steps it cannot express. */
export function lowerToBuildRequest(graph: BuildGraph, goal: string): LoweredBuild {
	const goalNode = graph.producerOf(goal);
	if (goalNode === undefined) { graph.nodesFor([goal]); }
	if (goalNode === undefined || goalNode.action.kind !== 'link') {
		const what = goalNode === undefined ? 'nothing' : goalNode.action.kind;
		throw new LowerError(`vscwClang: '${goal}' cannot be run: it is produced by ${what === 'archive' ? 'an archive' : `a ${what} step`}, not a link. Did you mean the program that links it?`);
	}
	graph.validate();
	const notes: string[] = [];
	const sourceFlags = new Map<string, string[]>();
	const visited = new Set<GraphNode>();
	const flags: string[] = [];
	const link = goalNode.action;

	const addSource = (source: string, flagsFor: readonly string[], via: GraphNode) => {
		const known = sourceFlags.get(source);
		if (known !== undefined && JSON.stringify(known) !== JSON.stringify(flagsFor)) {
			throw new LowerError(`vscwClang: '${source}' is compiled twice with different flags (\`${via.action.command}\` and an earlier step). Did you mean to build it once, or to give each program its own copy of the source?`);
		}
		if (known === undefined) { sourceFlags.set(source, [...flagsFor]); }
		const generator = graph.producerOf(source);
		if (generator !== undefined) { throw generated(generator, source, via); }
	};
	const generated = (producer: GraphNode, path: string, consumer: GraphNode) =>
		new LowerError(`vscwClang: cannot lower \`${consumer.action.command}\`: its input '${path}' is made by \`${producer.action.command}\`, a ${producer.action.kind} step the browser build cannot run before compiling. Did you mean to commit the generated file?`);

	const visitInput = (path: string, consumer: GraphNode, linkLevelFlags: readonly string[]) => {
		const producer = graph.producerOf(path);
		if (producer === undefined) {
			if (SOURCE_EXTENSION.test(path)) { addSource(path, linkLevelFlags, consumer); return; }
			throw new LowerError(`vscwClang: cannot lower \`${consumer.action.command}\`: '${path}' is a prebuilt object or library that no build step makes, and the browser build can only link what it compiles itself. Did you mean to build it from source?`);
		}
		visitNode(producer);
	};
	const visitNode = (node: GraphNode) => {
		if (visited.has(node)) { return; }
		visited.add(node);
		const a: BuildAction = node.action;
		switch (a.kind) {
			case 'compile': addSource(a.source, a.flags, node); break;
			case 'archive': a.members.forEach(m => visitInput(m, node, [])); break;
			case 'mkdir': case 'noop': case 'remove': break;
			default: throw generated(node, node.outputs[0] ?? '', node);
		}
	};

	const libDirs = link.flags.filter(f => f.startsWith('-L')).map(f => f.slice(2));
	const nonLink = link.flags.filter(f => !LINK_FLAG.test(f));
	const hasDirectSources = link.inputs.some(i => graph.producerOf(i) === undefined && SOURCE_EXTENSION.test(i));
	if (nonLink.length > 0 && !hasDirectSources) { notes.push(`dropped ${nonLink.map(f => `'${f}'`).join(' ')} from the link line: each source keeps the flags of the step that compiled it`); }
	for (const input of link.inputs) { visitInput(input, goalNode, nonLink); }
	for (const flag of link.flags.filter(f => LINK_FLAG.test(f))) {
		const lib = /^-l(.+)$/.exec(flag)?.[1];
		const archive = lib === undefined ? undefined : libDirs.map(d => graph.producerOf(`${d}/lib${lib}.a`)).find(n => n !== undefined);
		if (archive !== undefined) {
			visitNode(archive);
			notes.push(`folded static library '${archive.outputs[0]}' into the program; dropped '${flag}'`);
		} else {
			flags.push(flag);
		}
	}
	notes.push('object file names are chosen by the toolchain, not by the build file');
	const sources = [...sourceFlags.keys()];
	return {
		sources: sources.map(toRelative),
		sourceFlags: Object.fromEntries(sourceFlags),
		flags,
		output: toRelative(goal),
		mode: [...sourceFlags.values()].some(f => f.includes('-g')) ? 'debug' : 'release',
		notes,
	};
}

/** @helper The guest paths of the programs `graph` links, in build order; the choices for `lowerToBuildRequest`. */
export function linkOutputs(graph: BuildGraph): string[] {
	return graph.nodes.filter(n => n.action.kind === 'link').flatMap(n => n.outputs);
}
