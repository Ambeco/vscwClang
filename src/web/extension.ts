import * as vscode from 'vscode';
import { VscwClangDebugAdapter } from './debug/debugAdapter';
import { buildWorkspace } from './buildWorkspace';
import { runProgram } from './runProgram';
import { registerTaskProvider } from './tasks';
import { publishDiagnostics } from './toolchain/diagnosticsCollection';
import { runProbe } from './probe';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('vscwclang');
	const diagnostics = vscode.languages.createDiagnosticCollection('vscwclang');
	context.subscriptions.push(log, diagnostics);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscwclang.build', async () => {
			const { folder, output, result } = await buildWorkspace(context, log);
			publishDiagnostics(diagnostics, folder, result.parsed, output);
			reportBuild(log, output, result.exitCode);
		}),
		vscode.commands.registerCommand('vscwclang.run', async () => {
			const { folder, output, result } = await buildWorkspace(context, log);
			publishDiagnostics(diagnostics, folder, result.parsed, output);
			if (reportBuild(log, output, result.exitCode)) { await runProgram(output, []); }
		}),
		registerTaskProvider(context, log),
		vscode.commands.registerCommand('vscwclang.probe', () => runProbe(context, log)),
		vscode.debug.registerDebugConfigurationProvider('vscwclang', {
			provideDebugConfigurations: () => [{ type: 'vscwclang', request: 'launch', name: 'Debug C++ (vscwClang)', program: 'a.out.wasm' }],
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('vscwclang', {
			createDebugAdapterDescriptor: session => new vscode.DebugAdapterInlineImplementation(new VscwClangDebugAdapter(session, log, context)),
		}),
	);
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
