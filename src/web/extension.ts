import * as vscode from 'vscode';
import { VscwClangDebugAdapter } from './debug/debugAdapter';
import { build } from './toolchain/toolchain';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('vscwclang');
	context.subscriptions.push(log);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscwclang.build', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!folder) { throw new Error('vscwClang: open a workspace folder first.'); }
			const sources = await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx}', '**/node_modules/**');
			const result = await build({ sources, output: vscode.Uri.joinPath(folder, 'a.out.wasm'), flags: [], mode: 'release' }, log);
			log.appendLine(result.diagnostics);
		}),
		vscode.debug.registerDebugConfigurationProvider('vscwclang', {
			provideDebugConfigurations: () => [{ type: 'vscwclang', request: 'launch', name: 'Debug C++ (vscwClang)', program: 'a.out.wasm' }],
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('vscwclang', {
			createDebugAdapterDescriptor: session => new vscode.DebugAdapterInlineImplementation(new VscwClangDebugAdapter(session, log)),
		}),
	);
}

export function deactivate() {}
