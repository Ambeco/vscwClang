import * as vscode from 'vscode';
import type { BuildOptions } from './buildWorkspace';
import { GUEST_WORKSPACE, toGuestPath } from './toolchain/guestPaths';
import { defaultBuildTask, hostToGuest, inferHostRoot, isCompilerTask, listLaunches, listTasks, planFromCompileCommands, planFromCompileFlags, planFromTask, ProjectModelError, taskForLaunch, type BuildPlan, type LaunchEntry, type TaskEntry, type VariableContext } from './toolchain/projectModel';

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
	let build = mapTask(entry, folder, log);
	if (build === undefined) {
		const database = await chooseCompileDatabase(context, folder, log);
		if (database.cancelled) { return { cancelled: true }; }
		build = database.options;
	}
	return { cancelled: false, launch, build };
}

const LAST_TARGET_KEY = 'vscwclang.lastCompileCommandsTarget';
const ALL_TARGETS = '(all targets)';

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).replace(/^﻿/, ''); } catch { return undefined; }
}

/**
 * Build options from the folder's `compile_commands.json` (or, failing that, `compile_flags.txt`), the next source
 * after `tasks.json`. Like CMake Tools' build target, a database naming several CMake targets asks which one to
 * build (the last choice is listed first); `cancelled` means the user dismissed that picker. Undefined options mean
 * "no database; use the extension's own settings".
 */
export async function chooseCompileDatabase(context: vscode.ExtensionContext, folder: vscode.Uri, log: vscode.OutputChannel): Promise<{ cancelled: boolean; options?: BuildOptions }> {
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const configured = settings.get<string>('compileCommands', '').trim();
	for (const name of configured !== '' ? [configured] : ['compile_commands.json', 'build/compile_commands.json']) {
		const text = await readText(vscode.Uri.joinPath(folder, name));
		if (text === undefined) { continue; }
		let db: unknown;
		try { db = JSON.parse(text); } catch (e) {
			throw new ProjectModelError(`vscwClang: ${name} is not valid JSON (${(e as Error).message}). Did you mean to regenerate it (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON)?`);
		}
		return planDatabase(context, folder, log, name, db, settings.get<string[]>('compileCommands.include', []));
	}
	const flagsText = await readText(vscode.Uri.joinPath(folder, 'compile_flags.txt'));
	if (flagsText === undefined) { return { cancelled: false }; }
	const plan = planFromCompileFlags(flagsText);
	log.appendLine(`[vscwclang] using compile_flags.txt: ${plan.flags.join(' ')}`);
	plan.notes.forEach(n => log.appendLine(`[vscwclang]   ${n}`));
	return { cancelled: false, options: { flags: plan.flags, mode: plan.mode } };
}

async function planDatabase(context: vscode.ExtensionContext, folder: vscode.Uri, log: vscode.OutputChannel, name: string, db: unknown, include: string[]): Promise<{ cancelled: boolean; options?: BuildOptions }> {
	const relative = (uri: vscode.Uri) => uri.path.slice(folder.path.length + 1);
	const entries = (Array.isArray(db) ? db : []) as { directory?: unknown; file?: unknown }[];
	const known = new Set((await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx}', '**/node_modules/**')).map(relative));
	// Share of the entries whose file, mapped with `root`, exists here. A root of "/" maps every path, so mapping alone proves nothing.
	const coverage = (root: string) => {
		const sources = entries.filter(e => typeof e?.file === 'string');
		const hits = sources.filter(e => {
			const cwd = typeof e.directory === 'string' ? hostToGuest(e.directory, '/workspace', root) ?? '/workspace' : '/workspace';
			const guest = hostToGuest(e.file as string, cwd, root);
			return guest !== undefined && known.has(guest.slice('/workspace/'.length));
		});
		return sources.length === 0 ? 0 : hits.length / sources.length;
	};
	let root = folder.path;
	if (coverage(root) === 0) {
		// Made on another machine or in another folder: find where the workspace folder sat on that machine.
		const inferred = inferHostRoot(db, rel => known.has(rel));
		if (inferred === undefined || coverage(inferred) < 0.5) {
			throw new ProjectModelError(`vscwClang: most files listed in ${name} do not exist in this workspace folder, so its paths cannot be mapped. Did you mean to open the folder it was generated for, or to regenerate it here?`);
		}
		root = inferred;
		log.appendLine(`[vscwclang] ${name} was made for '${inferred}'; mapping it to /workspace`);
	}
	let plan = planFromCompileCommands(db, root);
	let target: string | undefined;
	if (plan.targets.length > 1) {
		const last = context.workspaceState.get<string>(LAST_TARGET_KEY);
		const items = [ALL_TARGETS, ...plan.targets].sort((a, b) => Number(b === last) - Number(a === last));
		const picked = await vscode.window.showQuickPick(items, { title: `vscwClang: Build which CMake target from ${name}?` });
		if (picked === undefined) { return { cancelled: true }; }
		await context.workspaceState.update(LAST_TARGET_KEY, picked);
		if (picked !== ALL_TARGETS) { target = picked; plan = planFromCompileCommands(db, root, target); }
	}
	let sources = plan.sources;
	if (include.length > 0) {
		const allowed = new Set<string>();
		for (const glob of include) { (await vscode.workspace.findFiles(glob)).forEach(uri => allowed.add(relative(uri))); }
		sources = sources.filter(s => allowed.has(s));
		if (sources.length === 0) {
			throw new ProjectModelError(`vscwClang: none of the sources in ${name} match vscwclang.compileCommands.include (${include.join(', ')}). Did you mean a glob such as 'src/**'?`);
		}
	}
	log.appendLine(`[vscwclang] using ${name}${target === undefined ? '' : ` target '${target}'`}: ${sources.length} source file(s) with their own flags`);
	plan.notes.forEach(n => log.appendLine(`[vscwclang]   ${n}`));
	const sourceFlags = Object.fromEntries(sources.map(s => [s, plan.perFileFlags[s]]));
	return { cancelled: false, options: { sourceFiles: sources, sourceFlags, flags: [], mode: plan.mode } };
}
