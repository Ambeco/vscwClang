import * as vscode from 'vscode';
import { VscwClangDebugAdapter } from './debug/debugAdapter';
import { buildWorkspace, type BuildOptions } from './buildWorkspace';
import { chooseCompileDatabase, chooseRun, defaultBuildOptions, trackActiveCppFile } from './projectConfig';
import { runProgram } from './runProgram';
import { joinArgs, splitArgs } from './toolchain/runEnvironment';
import { registerTaskProvider } from './tasks';
import { publishDiagnostics } from './toolchain/diagnosticsCollection';
import { runProbe } from './probe';
import { getToolchainStore } from './toolchain/toolchain';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('vscwclang');
	const diagnostics = vscode.languages.createDiagnosticCollection('vscwclang');
	context.subscriptions.push(log, diagnostics, trackActiveCppFile());

	context.subscriptions.push(
		vscode.commands.registerCommand('vscwclang.build', async () => {
			const options = await buildOptionsFor(context, log);
			if (options.cancelled) { return; }
			const { folder, output, result } = await buildWorkspace(context, log, options.build);
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
		registerTaskProvider(context, log),
		vscode.commands.registerCommand('vscwclang.probe', () => runProbe(context, log)),
		vscode.debug.registerDebugConfigurationProvider('vscwclang', {
			provideDebugConfigurations: () => [{ type: 'vscwclang', request: 'launch', name: 'Debug C++ (vscwClang)', program: '.vscwclang/debug/a.out.wasm' }],
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('vscwclang', {
			createDebugAdapterDescriptor: session => new vscode.DebugAdapterInlineImplementation(new VscwClangDebugAdapter(session, log, context)),
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
	const settingsArgs = vscode.workspace.getConfiguration('vscwclang').get<string[]>('run.args', []);
	if (!folder) { return { cancelled: false, args: settingsArgs }; }
	const chosen = await chooseRun(context, folder, log);
	return { cancelled: chosen.cancelled, args: chosen.launch?.args ?? settingsArgs, build: chosen.build };
}

async function buildAndRun(context: vscode.ExtensionContext, log: vscode.OutputChannel, diagnostics: vscode.DiagnosticCollection, args: string[], build?: BuildOptions): Promise<void> {
	const { folder, output, result } = await buildWorkspace(context, log, build);
	publishDiagnostics(diagnostics, folder, result.parsed, output);
	if (reportBuild(log, output, result.exitCode)) { await runProgram(context, output, args); }
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
