import * as vscode from 'vscode';
import { VsclangDebugAdapter } from './debug/debugAdapter';
import { build } from './toolchain/toolchain';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('vsclang');
	context.subscriptions.push(log);

	context.subscriptions.push(
		vscode.commands.registerCommand('vsclang.build', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!folder) { throw new Error('vsclang: open a workspace folder first.'); }
			const sources = await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx}', '**/node_modules/**');
			const result = await build({ sources, output: vscode.Uri.joinPath(folder, 'a.out.wasm'), flags: [], mode: 'release' }, log);
			log.appendLine(result.diagnostics);
		}),
		vscode.debug.registerDebugConfigurationProvider('vsclang', {
			provideDebugConfigurations: () => [{ type: 'vsclang', request: 'launch', name: 'Debug C++ (vsclang)', program: 'a.out.wasm' }],
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('vsclang', {
			createDebugAdapterDescriptor: session => new vscode.DebugAdapterInlineImplementation(new VsclangDebugAdapter(session, log)),
		}),
	);
}

export function deactivate() {}
