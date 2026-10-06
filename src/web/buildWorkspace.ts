import * as vscode from 'vscode';
import { build, type BuildResult } from './toolchain/toolchain';

export interface WorkspaceBuild {
	folder: vscode.Uri;
	output: vscode.Uri;
	result: BuildResult;
}

/** Builds every C/C++ source found under the first workspace folder with `sourceGlobs` into `outputName`. */
export async function buildWorkspace(context: vscode.ExtensionContext, log: vscode.OutputChannel, options: {
	sourceGlobs?: string[]; outputName?: string; flags?: string[]; mode?: 'debug' | 'release';
} = {}): Promise<WorkspaceBuild> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder first.'); }
	const output = vscode.Uri.joinPath(folder, options.outputName ?? 'a.out.wasm');
	const found = new Map<string, vscode.Uri>();
	for (const glob of options.sourceGlobs ?? ['**/*.{c,cc,cpp,cxx}']) {
		for (const uri of await vscode.workspace.findFiles(glob, '**/node_modules/**')) { found.set(uri.toString(), uri); }
	}
	// The exclude glob is not honored on every virtual file system (seen under test-web), so filter again.
	const sources = [...found.values()].filter(uri => !/\/(node_modules|\.git|\.vscwclang)\//.test(uri.path));
	const result = await build({ sources, output, flags: options.flags ?? [], mode: options.mode ?? 'release' }, log, context);
	log.appendLine(result.diagnostics);
	return { folder, output, result };
}
