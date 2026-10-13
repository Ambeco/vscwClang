import * as vscode from 'vscode';
import type { BuildOptions } from './buildWorkspace';
import { compileCommandsPath, cppToolsFlags, mergeExclude } from './toolchain/cppToolsSettings';
import { GUEST_WORKSPACE, stripWorkspaceFolder, toGuestPath } from './toolchain/guestPaths';
import { DEFAULT_EXCLUDE, makeSourceExcluder } from './toolchain/sourceFilter';
import { defaultBuildTask, hostToGuest, inferHostRoot, isCompilerTask, listLaunches, listTasks, planFromCompileCommands, planFromCompileFlags, planFromTask, ProjectModelError, resolveVariables, taskForLaunch, type BuildPlan, type LaunchEntry, type TaskEntry, type VariableContext } from './toolchain/projectModel';

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

/** Whether the user (not just the extension's default) set this setting anywhere. */
export function isUserSet(config: vscode.WorkspaceConfiguration, key: string): boolean {
	const i = config.inspect(key);
	return i !== undefined && [i.globalValue, i.workspaceValue, i.workspaceFolderValue, i.globalLanguageValue, i.workspaceLanguageValue, i.workspaceFolderLanguageValue].some(v => v !== undefined);
}

/**
 * The flags Build and clangd use when no task or compile database supplies them: `vscwclang.flags` if the user set
 * it, else its default plus whatever their `C_Cpp.default.*` settings (cpptools, usually from a desktop session on
 * the same project) ask for. `vscwclang.useCppToolsSettings` turns the fallback off. Notes about unusable entries
 * go to `log` when given.
 *
 * `${workspaceFolder}` and the other variables (see `resolveVariables`) are expanded in every entry; an entry that
 * cannot be (an `${env:...}`, or `${file}` with no editor) is an error, or with `lenient` (clangd's startup flags,
 * which have no active file) is dropped with a note.
 *
 * The C and C++ standards are returned apart (`c`, `cpp`) because `-std=` is an error for the other language;
 * clangd's single fallback flag list therefore ignores them.
 */
export function userFlags(log?: vscode.OutputChannel, lenient = false): { flags: string[]; c: string[]; cpp: string[] } {
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const own = resolveSettingStrings(settings.get<string[]>('flags', []), 'vscwclang.flags', log, lenient);
	if (isUserSet(settings, 'flags') || !settings.get<boolean>('useCppToolsSettings', true)) { return { flags: own, c: [], cpp: [] }; }
	const cpptools = vscode.workspace.getConfiguration('C_Cpp');
	const mapped = cppToolsFlags({
		defines: cpptools.get('default.defines'),
		includePath: cpptools.get('default.includePath'),
		compilerArgs: cpptools.get('default.compilerArgs'),
		cppStandard: cpptools.get('default.cppStandard'),
		cStandard: cpptools.get('default.cStandard'),
	}, text => resolveVariables(text, settingsContext()));
	mapped.notes.forEach(n => log?.appendLine(`[vscwclang] ${n}`));
	return { flags: [...own, ...mapped.flags], c: mapped.cFlags, cpp: mapped.cppFlags };
}

function settingsContext(): VariableContext {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	return folder ? variableContext(folder) : { folderName: '' };
}

/**
 * Expands `${workspaceFolder}` (as `/workspace`, the path the compiler and program see) and the other variables
 * `resolveVariables` knows in the strings of a setting meant for them (flags, program arguments, environment).
 * An unusable entry throws naming the setting; with `lenient` it is dropped and logged instead.
 */
export function resolveSettingStrings(values: readonly string[], setting: string, log?: vscode.OutputChannel, lenient = false): string[] {
	const ctx = settingsContext();
	const out: string[] = [];
	for (const value of values) {
		try { out.push(resolveVariables(value, ctx)); } catch (e) {
			const message = `${(e as Error).message} (in the ${setting} setting, entry '${value}')`;
			if (!lenient) { throw new ProjectModelError(message); }
			log?.appendLine(`[vscwclang] skipped: ${message.replace(/^vscwClang: /, '')}`);
		}
	}
	return out;
}

/** `vscwclang.run.args` with variables expanded. */
export function runArgsSetting(): string[] {
	return resolveSettingStrings(vscode.workspace.getConfiguration('vscwclang').get<string[]>('run.args', []), 'vscwclang.run.args');
}

/** `vscwclang.run.env` with variables expanded in its values (`null`, which removes a default, is kept). */
export function runEnvSetting(): Record<string, string | null> {
	const env = vscode.workspace.getConfiguration('vscwclang').get<Record<string, string | null>>('run.env', {});
	const names = Object.keys(env).filter(k => typeof env[k] === 'string');
	const values = resolveSettingStrings(names.map(k => env[k] as string), 'vscwclang.run.env');
	return { ...env, ...Object.fromEntries(names.map((k, i) => [k, values[i]])) };
}

/** `vscwclang.sourceGlobs`-style globs, which are host-relative, so `${workspaceFolder}/` is just dropped. */
export function workspaceRelativeGlobs(setting: string, fallback: string[]): string[] {
	return vscode.workspace.getConfiguration('vscwclang').get<string[]>(setting, fallback).map(stripWorkspaceFolder);
}

/**
 * Predicate for `vscwclang.files.exclude` (glob object, like cpptools' `C_Cpp.files.exclude`, which is merged in
 * unless `vscwclang.useCppToolsSettings` is off). Takes a path relative to the workspace folder.
 */
export function sourceExcluder(): (relativePath: string) => boolean {
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const own = settings.get<Record<string, unknown>>('files.exclude', { ...DEFAULT_EXCLUDE });
	const cpptools = settings.get<boolean>('useCppToolsSettings', true) ? vscode.workspace.getConfiguration('C_Cpp').get<unknown>('files.exclude') : undefined;
	return makeSourceExcluder(mergeExclude(own, isUserSet(settings, 'files.exclude'), cpptools));
}

/** `vscwclang.loggingLevel`, defaulting to the user's `C_Cpp.loggingLevel` when ours is unset. */
export function loggingLevel(): string {
	const settings = vscode.workspace.getConfiguration('vscwclang');
	return isUserSet(settings, 'loggingLevel') ? settings.get<string>('loggingLevel', 'Error') : vscode.workspace.getConfiguration('C_Cpp').get<string>('loggingLevel') ?? 'Error';
}

/** `vscwclang.intelliSense.enabled`, defaulting to off when the user's `C_Cpp.intelliSenseEngine` is `disabled`. */
export function intelliSenseEnabled(): boolean {
	const settings = vscode.workspace.getConfiguration('vscwclang');
	if (isUserSet(settings, 'intelliSense.enabled')) { return settings.get<boolean>('intelliSense.enabled', true); }
	return vscode.workspace.getConfiguration('C_Cpp').get<string>('intelliSenseEngine') !== 'disabled';
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
	const configured = compileCommandsPath(settings.get<unknown>('compileCommands')) ?? compileCommandsPath(vscode.workspace.getConfiguration('C_Cpp').get<unknown>('default.compileCommands')) ?? '';
	for (const name of configured !== '' ? [configured] : ['compile_commands.json', 'build/compile_commands.json']) {
		const text = await readText(vscode.Uri.joinPath(folder, name));
		if (text === undefined) { continue; }
		let db: unknown;
		try { db = JSON.parse(text); } catch (e) {
			throw new ProjectModelError(`vscwClang: ${name} is not valid JSON (${(e as Error).message}). Did you mean to regenerate it (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON)?`);
		}
		return planDatabase(context, folder, log, name, db, workspaceRelativeGlobs('compileCommands.include', []));
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
