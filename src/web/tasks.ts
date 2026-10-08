import * as vscode from 'vscode';
import { buildWorkspace, type BuildOptions } from './buildWorkspace';
import { optionsFromPlan, variableContext } from './projectConfig';
import { planFromTask, type TaskLike } from './toolchain/projectModel';

interface VscwClangTaskDefinition extends vscode.TaskDefinition {
	/** Source globs relative to the workspace folder; default all C/C++ files. */
	sources?: string[];
	flags?: string[];
	mode?: 'debug' | 'release';
	output?: string;
}

/**
 * Provides `vscwclang` build tasks. Output is clang's own text (guest paths included) written to the task
 * terminal so the `$vscwclang` problem matcher in package.json can produce Problems entries.
 *
 * Also resolves `cppbuild` tasks (the C/C++ extension's type, as written into `tasks.json` for g++/clang++) by mapping their
 * command line onto a build; they are never offered, only resolved. Tasks of type `shell` that call g++ cannot be
 * intercepted by a provider; the Build and Run commands map the default build task instead.
 */
export function registerTaskProvider(context: vscode.ExtensionContext, log: vscode.OutputChannel): vscode.Disposable {
	const provider = createTaskProvider(context, log);
	return vscode.Disposable.from(vscode.tasks.registerTaskProvider('vscwclang', provider), vscode.tasks.registerTaskProvider('cppbuild', { provideTasks: () => [], resolveTask: provider.resolveTask }));
}

/** Exposed so tests can resolve a task directly (the workbench offers no way to run a configured task by name). */
export function createTaskProvider(context: vscode.ExtensionContext, log: vscode.OutputChannel): vscode.TaskProvider {
	const makeTask = (def: VscwClangTaskDefinition, scope: vscode.WorkspaceFolder | vscode.TaskScope) => {
		const task = new vscode.Task(def, scope, def.mode === 'debug' ? 'build (debug)' : 'build', 'vscwclang',
			new vscode.CustomExecution(async () => new BuildPseudoterminal(context, log, async () => ({ sourceGlobs: def.sources, outputName: def.output, flags: def.flags, mode: def.mode }))), '$vscwclang');
		task.group = vscode.TaskGroup.Build;
		return task;
	};
	const makeCppbuildTask = (original: vscode.Task) => {
		const folder = (original.scope !== undefined && typeof original.scope === 'object' ? original.scope.uri : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		const task = new vscode.Task(original.definition, original.scope ?? vscode.TaskScope.Workspace, original.name, 'cppbuild',
			new vscode.CustomExecution(async () => new BuildPseudoterminal(context, log, async () => {
				if (!folder) { throw new Error('vscwClang: open a workspace folder first.'); }
				const plan = planFromTask({ label: original.name, ...original.definition } as TaskLike, variableContext(folder));
				plan.notes.forEach(n => log.appendLine(`[vscwclang]   ${n}`));
				return optionsFromPlan(plan);
			})), '$vscwclang');
		task.group = original.group;
		return task;
	};
	return {
		provideTasks: () => [makeTask({ type: 'vscwclang', mode: 'release' }, vscode.TaskScope.Workspace), makeTask({ type: 'vscwclang', mode: 'debug' }, vscode.TaskScope.Workspace)],
		resolveTask: task => task.definition.type === 'vscwclang' ? makeTask(task.definition as VscwClangTaskDefinition, task.scope ?? vscode.TaskScope.Workspace)
			: task.definition.type === 'cppbuild' ? makeCppbuildTask(task) : undefined,
	};
}

class BuildPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel, private readonly options: () => Promise<BuildOptions>) {}

	open(): void {
		void this.run().then(code => this.closeEmitter.fire(code), e => {
			this.print(`vscwClang: ${e instanceof Error ? e.message : String(e)}`);
			this.closeEmitter.fire(1);
		});
	}

	close(): void {}

	private async run(): Promise<number> {
		const { result } = await buildWorkspace(this.context, this.log, await this.options());
		this.print(result.diagnostics.trimEnd());
		this.print(result.exitCode === 0 ? 'vscwClang: build succeeded.' : `vscwClang: build failed (exit ${result.exitCode}).`);
		return result.exitCode;
	}

	private print(text: string): void {
		this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n') + '\r\n');
	}
}
