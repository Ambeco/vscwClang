import * as vscode from 'vscode';
import type { BuildOptions } from './buildWorkspace';
import { GUEST_WORKSPACE, toGuestPath } from './toolchain/guestPaths';
import { defaultBuildTask, isCompilerTask, listLaunches, listTasks, planFromTask, taskForLaunch, type BuildPlan, type LaunchEntry, type TaskEntry, type VariableContext } from './toolchain/projectModel';

const LAST_LAUNCH_KEY = 'vscwclang.lastLaunch';
const CPP_LANGUAGES = new Set(['c', 'cpp']);

let lastCppFile: vscode.Uri | undefined;

/** Remembers the last C/C++ file shown in an editor, since `${file}` is still meaningful while a terminal or panel has focus. */
export function trackActiveCppFile(): vscode.Disposable {
	const note = (editor: vscode.TextEditor | undefined) => {
		if (editor && CPP_LANGUAGES.has(editor.document.languageId)) { lastCppFile = editor.document.uri; }
	};
	note(vscode.window.activeTextEditor);
	return vscode.window.onDidChangeActiveTextEditor(note);
}

/** What `${file}` and friends mean right now: the last C/C++ editor, if it lies inside `folder`. */
export function variableContext(folder: vscode.Uri): VariableContext {
	const guest = lastCppFile && lastCppFile.scheme === folder.scheme ? toGuestPath(folder.path, lastCppFile.path) : undefined;
	return {
		folderName: folder.path.slice(folder.path.lastIndexOf('/') + 1),
		file: guest?.slice(GUEST_WORKSPACE.length + 1),
	};
}

export function readTasks(folder: vscode.Uri): TaskEntry[] {
	return listTasks(vscode.workspace.getConfiguration('tasks', folder).get<unknown[]>('tasks'));
}

export function readLaunches(folder: vscode.Uri): LaunchEntry[] {
	return listLaunches(vscode.workspace.getConfiguration('launch', folder).get<unknown[]>('configurations'), variableContext(folder));
}

export function optionsFromPlan(plan: BuildPlan): BuildOptions {
	return { sourceGlobs: plan.sources, flags: plan.flags, mode: plan.mode, artifactName: plan.outputName };
}

/** Maps a `tasks.json` task for the Build command; undefined (with a log line) when it is not a compiler task. */
export function mapTask(entry: TaskEntry | undefined, folder: vscode.Uri, log: vscode.OutputChannel): BuildOptions | undefined {
	if (entry === undefined) { return undefined; }
	if (!isCompilerTask(entry.task)) {
		log.appendLine(`[vscwclang] tasks.json task '${entry.label}' does not run g++/clang++, so it is not used; building with vscwclang settings.`);
		return undefined;
	}
	const plan = planFromTask(entry.task, variableContext(folder));
	log.appendLine(`[vscwclang] using tasks.json task '${entry.label}': ${plan.sources.join(' ')} ${plan.flags.join(' ')}`);
	plan.notes.forEach(n => log.appendLine(`[vscwclang]   ${n}`));
	return optionsFromPlan(plan);
}

/** The build options of the folder's default build task, when it is a g++/clang++ task. */
export function defaultBuildOptions(folder: vscode.Uri, log: vscode.OutputChannel): BuildOptions | undefined {
	return mapTask(defaultBuildTask(readTasks(folder)), folder, log);
}

/**
 * What Run should build and pass: the chosen `launch.json` configuration's `args` and the build task that makes its
 * program. With several configurations the user picks one (the last choice is listed first). Undefined parts mean
 * "use the extension's own settings"; `cancelled` means the user dismissed the picker.
 */
export async function chooseRun(context: vscode.ExtensionContext, folder: vscode.Uri, log: vscode.OutputChannel): Promise<{ cancelled: boolean; launch?: LaunchEntry; build?: BuildOptions }> {
	const launches = readLaunches(folder);
	let launch: LaunchEntry | undefined = launches[0];
	if (launches.length > 1) {
		const last = context.workspaceState.get<string>(LAST_LAUNCH_KEY);
		const ordered = [...launches].sort((a, b) => Number(b.name === last) - Number(a.name === last));
		const picked = await vscode.window.showQuickPick(ordered.map(l => ({ label: l.name, description: l.program, launch: l })), { title: 'vscwClang: Run which launch.json configuration?' });
		if (picked === undefined) { return { cancelled: true }; }
		launch = picked.launch;
		await context.workspaceState.update(LAST_LAUNCH_KEY, launch.name);
	}
	if (launch !== undefined) { log.appendLine(`[vscwclang] using launch.json configuration '${launch.name}'`); }
	const entry = taskForLaunch(readTasks(folder), launch, variableContext(folder));
	return { cancelled: false, launch, build: mapTask(entry, folder, log) };
}
