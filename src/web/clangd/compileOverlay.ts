import * as vscode from 'vscode';
import { sourceExcluder, workspaceRelativeGlobs } from '../projectConfig';

/** Workspace sources matching `vscwclang.sourceGlobs`, minus `vscwclang.files.exclude`. */
export async function discoverWorkspaceSources(): Promise<vscode.Uri[]> {
	const isExcluded = sourceExcluder();
	const found = new Map<string, vscode.Uri>();
	for (const glob of workspaceRelativeGlobs('sourceGlobs', ['**/*.{c,cc,cpp,cxx}'])) {
		for (const uri of await vscode.workspace.findFiles(glob, '**/node_modules/**')) { found.set(uri.toString(), uri); }
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	return [...found.values()].filter(uri => !folder || !isExcluded(uri.path.slice(folder.path.length)));
}

/**
 * Whether clangd will find a compilation database on its own (`compile_commands.json` at the root or in `build/`,
 * the `vscwclang.compileCommands` setting, or `compile_flags.txt`). Overlay commands would shadow its entries, so
 * the caller sends none then.
 */
export async function hasCompilationDatabase(folder: vscode.Uri, configured: string | undefined): Promise<boolean> {
	const candidates = [configured, 'compile_commands.json', 'build/compile_commands.json', 'compile_flags.txt'].filter((c): c is string => !!c);
	for (const relative of candidates) {
		try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, relative)); return true; } catch { /* not there */ }
	}
	return false;
}
