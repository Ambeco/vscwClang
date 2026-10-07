import * as vscode from 'vscode';
import { DEFAULT_EXCLUDED_DIRS, isExcludedSource } from './toolchain/sourceFilter';
import { build, type BuildResult } from './toolchain/toolchain';

export interface WorkspaceBuild {
	folder: vscode.Uri;
	output: vscode.Uri;
	result: BuildResult;
}

/**
 * Builds the C/C++ sources found under the first workspace folder into `outputName`.
 *
 * Sources come from `sourceGlobs` (default: the `vscwclang.sourceGlobs` setting), minus any file under a directory
 * named in `vscwclang.sourceExclude` (IDE scratch and build-output folders by default).
 */
export async function buildWorkspace(context: vscode.ExtensionContext, log: vscode.OutputChannel, options: {
	sourceGlobs?: string[]; outputName?: string; flags?: string[]; mode?: 'debug' | 'release';
} = {}): Promise<WorkspaceBuild> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder first.'); }
	const output = vscode.Uri.joinPath(folder, options.outputName ?? 'a.out.wasm');
	const found = new Map<string, vscode.Uri>();
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const excluded = settings.get<string[]>('sourceExclude', DEFAULT_EXCLUDED_DIRS);
	for (const glob of options.sourceGlobs ?? settings.get<string[]>('sourceGlobs', ['**/*.{c,cc,cpp,cxx}'])) {
		for (const uri of await vscode.workspace.findFiles(glob, '**/node_modules/**')) { found.set(uri.toString(), uri); }
	}
	// findFiles' exclude glob is not honored on every virtual file system (seen under test-web), so filter ourselves.
	const sources = [...found.values()].filter(uri => !isExcludedSource(uri.path.slice(folder.path.length), excluded));
	log.appendLine(`[vscwclang] ${sources.length} source file(s) found (skipping directories named: ${excluded.join(', ')})`);
	const result = await build({ sources, output, flags: options.flags ?? settings.get<string[]>('flags', []), mode: options.mode ?? 'release' }, log, context);
	log.appendLine(result.diagnostics);
	return { folder, output, result };
}
