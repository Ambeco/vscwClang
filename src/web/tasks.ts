import * as vscode from 'vscode';
import { buildWorkspace } from './buildWorkspace';

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
 */
export function registerTaskProvider(context: vscode.ExtensionContext, log: vscode.OutputChannel): vscode.Disposable {
	const makeTask = (def: VscwClangTaskDefinition, scope: vscode.WorkspaceFolder | vscode.TaskScope) => {
		const task = new vscode.Task(def, scope, def.mode === 'debug' ? 'build (debug)' : 'build', 'vscwclang',
			new vscode.CustomExecution(async () => new BuildPseudoterminal(def, context, log)), '$vscwclang');
		task.group = vscode.TaskGroup.Build;
		return task;
	};
	return vscode.tasks.registerTaskProvider('vscwclang', {
		provideTasks: () => [makeTask({ type: 'vscwclang', mode: 'release' }, vscode.TaskScope.Workspace), makeTask({ type: 'vscwclang', mode: 'debug' }, vscode.TaskScope.Workspace)],
		resolveTask: task => task.definition.type === 'vscwclang' ? makeTask(task.definition as VscwClangTaskDefinition, task.scope ?? vscode.TaskScope.Workspace) : undefined,
	});
}

class BuildPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	constructor(private readonly def: VscwClangTaskDefinition, private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {}

	open(): void {
		void this.run().then(code => this.closeEmitter.fire(code), e => {
			this.print(`vscwClang: ${e instanceof Error ? e.message : String(e)}`);
			this.closeEmitter.fire(1);
		});
	}

	close(): void {}

	private async run(): Promise<number> {
		const { result } = await buildWorkspace(this.context, this.log, { sourceGlobs: this.def.sources, outputName: this.def.output, flags: this.def.flags, mode: this.def.mode });
		this.print(result.diagnostics.trimEnd());
		this.print(result.exitCode === 0 ? 'vscwClang: build succeeded.' : `vscwClang: build failed (exit ${result.exitCode}).`);
		return result.exitCode;
	}

	private print(text: string): void {
		this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n') + '\r\n');
	}
}
