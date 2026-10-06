import * as vscode from 'vscode';
import { VscwClangDebugAdapter } from './debug/debugAdapter';
import { build } from './toolchain/toolchain';
import { publishDiagnostics } from './toolchain/diagnosticsCollection';
import { runProbe } from './probe';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('vscwclang');
	const diagnostics = vscode.languages.createDiagnosticCollection('vscwclang');
	context.subscriptions.push(log, diagnostics);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscwclang.build', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!folder) { throw new Error('vscwClang: open a workspace folder first.'); }
			const output = vscode.Uri.joinPath(folder, 'a.out.wasm');
			const sources = await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx}', '**/node_modules/**');
			const result = await build({ sources, output, flags: [], mode: 'release' }, log, context);
			log.appendLine(result.diagnostics);
			publishDiagnostics(diagnostics, folder, result.parsed, output);
			if (result.exitCode !== 0) {
				log.show(true);
				vscode.window.showErrorMessage(`vscwClang: build failed (exit ${result.exitCode}); see Problems and the vscwclang output.`);
			} else {
				vscode.window.showInformationMessage(`vscwClang: built ${vscode.workspace.asRelativePath(output)}.`);
			}
		}),
		vscode.commands.registerCommand('vscwclang.probe', () => runProbe(context, log)),
		vscode.debug.registerDebugConfigurationProvider('vscwclang', {
			provideDebugConfigurations: () => [{ type: 'vscwclang', request: 'launch', name: 'Debug C++ (vscwClang)', program: 'a.out.wasm' }],
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('vscwclang', {
			createDebugAdapterDescriptor: session => new vscode.DebugAdapterInlineImplementation(new VscwClangDebugAdapter(session, log, context)),
		}),
	);
}

export function deactivate() {}
