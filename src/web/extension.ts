import * as vscode from 'vscode';
import { VscwClangDebugAdapter, type DebugLaunchPlan } from './debug/debugAdapter';
import { DEFAULT_LAUNCH, resolveLaunchConfiguration } from './debug/launchConfiguration';
import { buildWorkspace, type BuildOptions } from './buildWorkspace';
import { chooseCompileDatabase, chooseRun, defaultBuildOptions, runArgsSetting, trackActiveCppFile } from './projectConfig';
import { runProgram } from './runProgram';
import { joinArgs, splitArgs } from './toolchain/runEnvironment';
import { registerTaskProvider } from './tasks';
import { publishDiagnostics } from './toolchain/diagnosticsCollection';
import { buildCacheStats, clearBuildCache, getToolchainStore, markIntelliSenseSettled } from './toolchain/toolchain';
import { startClangdClient } from './clangd/clangdClient';
import { wasReported } from './toolchain/toolchainStore';
import { pickCounterpart } from './switchSource';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('vscwclang');
	const diagnostics = vscode.languages.createDiagnosticCollection('vscwclang');
	context.subscriptions.push(log, diagnostics, trackActiveCppFile());
	const folders = vscode.workspace.workspaceFolders ?? [];
	log.appendLine(`[vscwclang] workspace: ${vscode.workspace.workspaceFile?.toString() ?? 'single folder (no workspace file)'}; folders: ${folders.map(f => f.uri.toString()).join(', ') || 'none'}`);
	let clangdFailed = false;
	let clangdStarting = false;
	const tryStartClangd = () => {
		if (clangdStarting) { return; }
		clangdStarting = true;
		void startClangdClient(context, log).then(d => { clangdFailed = false; if (d) { context.subscriptions.push(d); } else { markIntelliSenseSettled(); } },
			e => {
				markIntelliSenseSettled();
				const message = e instanceof Error ? e.message : String(e);
				const firstFailure = !clangdFailed;
				clangdFailed = true;
				log.appendLine(`[vscwclang] clangd did not start: ${message}`);
				if (firstFailure && !wasReported(e)) {
					void vscode.window.showWarningMessage(`vscwClang: IntelliSense (clangd) did not start, so completion and hover are unavailable; Build and Run still work. Reason: ${message} It starts again by itself once the toolchain has downloaded (e.g. after Build or Download Toolchain), or after a window reload.`, 'Show Log').then(choice => { if (choice) { log.show(true); } });
				}
			}).finally(() => { clangdStarting = false; });
	};
	getToolchainStore(context, log).prefetch();
	tryStartClangd();
	context.subscriptions.push(getToolchainStore(context, log).onDidEnsure(() => { if (clangdFailed) { tryStartClangd(); } }));

	context.subscriptions.push(
		vscode.commands.registerCommand('vscwclang.build', async () => {
			const options = await buildOptionsFor(context, log);
			if (options.cancelled) { return; }
			const { folder, output, result } = await buildWorkspace(context, log, options.build, (parsed, f, o) => publishDiagnostics(diagnostics, f, parsed, o));
			publishDiagnostics(diagnostics, folder, result.parsed, output);
			reportBuild(log, output, result.exitCode);
		}),
		vscode.commands.registerCommand('vscwclang.run', async () => {
			const run = await runPlan(context, log);
			if (!run.cancelled) { await buildAndRun(context, log, diagnostics, run.args, run.build); }
		}),
		vscode.commands.registerCommand('vscwclang.runWithArgs', async () => {
			const run = await runPlan(context, log);
			if (run.cancelled) { return; }
			const settingsArgs = joinArgs(run.args);
			const line = await vscode.window.showInputBox({
				title: 'vscwClang: Run arguments',
				prompt: 'Command-line arguments for the program (quotes group words; files are under /workspace, e.g. input.txt or /workspace/data/in.txt)',
				value: context.workspaceState.get<string>(LAST_ARGS_KEY, settingsArgs),
				validateInput: text => { try { splitArgs(text); return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } },
			});
			if (line === undefined) { return; }
			await context.workspaceState.update(LAST_ARGS_KEY, line);
			await buildAndRun(context, log, diagnostics, splitArgs(line), run.build);
		}),
		vscode.commands.registerCommand('vscwclang.downloadToolchain', async () => {
			await getToolchainStore(context, log).ensure();
			void vscode.window.showInformationMessage('vscwClang: toolchain is downloaded and cached.');
		}),
		vscode.commands.registerCommand('vscwclang.clearToolchainCache', async () => {
			await getToolchainStore(context, log).clear();
			void vscode.window.showInformationMessage('vscwClang: downloaded toolchain removed; it will be downloaded again on next use.');
		}),
		vscode.commands.registerCommand('vscwclang.clearBuildCache', async () => {
			const before = await buildCacheStats();
			await clearBuildCache();
			void vscode.window.showInformationMessage(`vscwClang: build cache cleared (${before.objects} objects, ${(before.bytes / 1048576).toFixed(1)} MB); the next build recompiles everything.`);
		}),
		vscode.commands.registerCommand('vscwclang.switchHeaderSource', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }
			const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
			if (!folder) { void vscode.window.showWarningMessage('vscwClang: Switch Header/Source needs the file to be inside an open workspace folder.'); return; }
			const current = vscode.workspace.asRelativePath(editor.document.uri, false);
			const stem = current.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
			const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/${stem}.*`), '**/{node_modules,.git}/**', 200);
			const target = pickCounterpart(current, found.map(u => vscode.workspace.asRelativePath(u, false)));
			if (target === undefined) {
				void vscode.window.showInformationMessage(`vscwClang: no matching header or source named "${stem}" with a C/C++ extension was found in ${folder.name}.`);
				return;
			}
			await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, target));
		}),
		registerTaskProvider(context, log),
		vscode.debug.registerDebugConfigurationProvider('vscwclang', {
			provideDebugConfigurations: () => [{ ...DEFAULT_LAUNCH }],
			resolveDebugConfiguration: (_folder, config) => resolveLaunchConfiguration(config) as vscode.DebugConfiguration,
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('vscwclang', {
			createDebugAdapterDescriptor: session => new vscode.DebugAdapterInlineImplementation(new VscwClangDebugAdapter(session, log, context, () => debugPlan(context, log, diagnostics))),
		}),
	);
}

const LAST_ARGS_KEY = 'vscwclang.lastRunArgs';

/** Build's options: the default `tasks.json` build task, else `compile_commands.json`/`compile_flags.txt`, else the settings (undefined). */
async function buildOptionsFor(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<{ cancelled: boolean; build?: BuildOptions }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { return { cancelled: false }; }
	const fromTask = defaultBuildOptions(folder, log);
	if (fromTask !== undefined) { return { cancelled: false, build: fromTask }; }
	const database = await chooseCompileDatabase(context, folder, log);
	return { cancelled: database.cancelled, build: database.options };
}

/** Arguments and build for Run: from `launch.json` and its build task if present, else the `vscwclang` settings. */
async function runPlan(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<{ cancelled: boolean; args: string[]; build?: BuildOptions }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { return { cancelled: false, args: runArgsSetting() }; }
	const chosen = await chooseRun(context, folder, log);
	return { cancelled: chosen.cancelled, args: chosen.launch?.args ?? runArgsSetting(), build: chosen.build };
}

async function buildAndRun(context: vscode.ExtensionContext, log: vscode.OutputChannel, diagnostics: vscode.DiagnosticCollection, args: string[], build?: BuildOptions): Promise<void> {
	// Release even when the task has -g (which selects debug mode): a debug build links the stub that waits for a debugger host at startup.
	const { folder, output, result } = await buildWorkspace(context, log, { ...build, mode: 'release' }, (parsed, f, o) => publishDiagnostics(diagnostics, f, parsed, o));
	publishDiagnostics(diagnostics, folder, result.parsed, output);
	if (reportBuild(log, output, result.exitCode)) { await runProgram(context, output, args); }
}

/** Builds the workspace in debug mode with the same sources, flags and arguments as Run; undefined if the build fails or is cancelled. */
async function debugPlan(context: vscode.ExtensionContext, log: vscode.OutputChannel, diagnostics: vscode.DiagnosticCollection): Promise<DebugLaunchPlan | undefined> {
	const run = await runPlan(context, log);
	if (run.cancelled) { return undefined; }
	const { folder, output, result } = await buildWorkspace(context, log, { ...run.build, mode: 'debug' }, (parsed, f, o) => publishDiagnostics(diagnostics, f, parsed, o));
	publishDiagnostics(diagnostics, folder, result.parsed, output);
	return reportBuild(log, output, result.exitCode) ? { output, args: run.args } : undefined;
}

function reportBuild(log: vscode.OutputChannel, output: vscode.Uri, exitCode: number): boolean {
	if (exitCode !== 0) {
		log.show(true);
		void vscode.window.showErrorMessage(`vscwClang: build failed (exit ${exitCode}); see Problems and the vscwclang output.`);
		return false;
	}
	void vscode.window.showInformationMessage(`vscwClang: built ${vscode.workspace.asRelativePath(output)}.`);
	return true;
}

export function deactivate() {}
