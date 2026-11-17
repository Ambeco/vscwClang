import type { BuildAction } from './classify';

export class BuildGraphError extends Error {}

export interface GraphNode {
	id: number;
	action: BuildAction;
	inputs: string[];
	outputs: string[];
	/** Name of the build target (a make target) whose recipe contained the action. */
	target?: string;
}

function ioOf(action: BuildAction): { inputs: string[]; outputs: string[] } {
	switch (action.kind) {
		case 'compile': return { inputs: [action.source], outputs: [action.output] };
		case 'link': return { inputs: action.inputs, outputs: [action.output] };
		case 'archive': return { inputs: action.members, outputs: [action.output] };
		case 'mkdir': return { inputs: [], outputs: action.paths };
		case 'copy': return { inputs: action.from, outputs: [action.to] };
		case 'move': return { inputs: [action.from], outputs: [action.to] };
		case 'touch': return { inputs: [], outputs: action.paths };
		case 'write': return { inputs: [], outputs: [action.path] };
		case 'remove': case 'noop': return { inputs: [], outputs: [] };
	}
}

const isBuildProduct = (a: BuildAction) => a.kind === 'compile' || a.kind === 'link' || a.kind === 'archive';
const isUnder = (path: string, dir: string) => path.startsWith(`${dir}/`);

/**
 * The build graph: one node per classified build action, edges implied by the files they read and write. Vscode-free.
 *
 * Front ends (the make dry-run reader, later Ninja and CMake readers) add nodes in the order the build tool would run
 * them; `addNode` derives each node's `inputs` and `outputs` from its action. A node depends on every earlier node
 * that produces one of its inputs or that creates a directory above one of its outputs. A path no node produces is a
 * plain source file. `validate` throws `BuildGraphError` for two compile/link/archive nodes producing one path (file actions may repeat, e.g. appending to a file) and for cycles; `nodesFor`
 * returns the nodes a goal needs, dependencies first, otherwise in the order they were added. Asking for a path
 * nothing produces throws with the closest produced paths as suggestions.
 *
 * `copy` to a destination that is a directory is recorded as producing the destination path itself, since the graph
 * cannot see the file system.
 *
 * @helper
 */
export class BuildGraph {
	readonly nodes: GraphNode[] = [];
	private readonly producers = new Map<string, GraphNode>();
	private readonly mkdirs: { dir: string; node: GraphNode }[] = [];

	addNode(action: BuildAction, target?: string): GraphNode {
		const { inputs, outputs } = ioOf(action);
		const node: GraphNode = { id: this.nodes.length, action, inputs, outputs, target };
		for (const out of outputs) {
			const previous = this.producers.get(out);
			if (previous !== undefined && isBuildProduct(previous.action) && isBuildProduct(action)) {
				throw new BuildGraphError(`vscwClang: '${out}' is produced twice: by \`${previous.action.command}\` and by \`${action.command}\`. Did you mean to build it once, or to give the two steps different outputs?`);
			}
			if (previous === undefined) { this.producers.set(out, node); }
			if (action.kind === 'mkdir') { this.mkdirs.push({ dir: out, node }); }
		}
		this.nodes.push(node);
		return node;
	}

	producerOf(path: string): GraphNode | undefined {
		return this.producers.get(path);
	}

	dependenciesOf(node: GraphNode): GraphNode[] {
		const found = new Set<GraphNode>();
		for (const input of node.inputs) {
			const producer = this.producers.get(input);
			if (producer !== undefined && producer !== node) { found.add(producer); }
		}
		if (node.action.kind !== 'mkdir') {
			for (const out of node.outputs) {
				for (const m of this.mkdirs) {
					if (m.node !== node && isUnder(out, m.dir)) { found.add(m.node); }
				}
			}
		}
		return [...found];
	}

	validate(): void {
		const state = new Map<GraphNode, 'visiting' | 'done'>();
		const visit = (node: GraphNode, trail: GraphNode[]) => {
			if (state.get(node) === 'done') { return; }
			if (state.get(node) === 'visiting') {
				const cycle = [...trail.slice(trail.indexOf(node)), node].map(n => `\`${n.action.command}\``).join(' -> ');
				throw new BuildGraphError(`vscwClang: the build steps depend on each other in a cycle: ${cycle}. Did you mean to remove one of the dependencies in the build file?`);
			}
			state.set(node, 'visiting');
			for (const dep of this.dependenciesOf(node)) { visit(dep, [...trail, node]); }
			state.set(node, 'done');
		};
		this.nodes.forEach(n => visit(n, []));
	}

	/** The nodes needed to produce `goals` (paths), dependencies before dependents, otherwise in insertion order. */
	nodesFor(goals: readonly string[]): GraphNode[] {
		this.validate();
		const needed = new Set<GraphNode>();
		const collect = (node: GraphNode) => {
			if (needed.has(node)) { return; }
			needed.add(node);
			this.dependenciesOf(node).forEach(collect);
		};
		for (const goal of goals) {
			const producer = this.producers.get(goal);
			if (producer === undefined) { throw this.unknownGoal(goal); }
			collect(producer);
		}
		const ordered: GraphNode[] = [];
		const done = new Set<GraphNode>();
		const place = (node: GraphNode) => {
			if (done.has(node)) { return; }
			done.add(node);
			this.dependenciesOf(node).sort((x, y) => x.id - y.id).forEach(place);
			ordered.push(node);
		};
		this.nodes.filter(n => needed.has(n)).forEach(place);
		return ordered;
	}

	private unknownGoal(goal: string): BuildGraphError {
		const produced = [...this.producers.keys()];
		const base = goal.replace(/^.*\//, '');
		const close = produced.filter(p => p.replace(/^.*\//, '') === base || p.includes(base)).slice(0, 5);
		const hint = close.length > 0 ? `Did you mean ${close.map(c => `'${c}'`).join(', ')}?` : `No step produces anything like it; did you mean one of ${produced.slice(0, 5).map(c => `'${c}'`).join(', ')}?`;
		return new BuildGraphError(`vscwClang: no build step produces '${goal}'. ${hint}`);
	}
}
