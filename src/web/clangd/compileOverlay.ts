import * as vscode from 'vscode';
import { sourceExcluder, workspaceRelativeGlobs } from '../projectConfig';
import { OUTPUT_FOLDER_MARKERS, makeSourceExcluder, outputFolderExclude } from '../toolchain/sourceFilter';

/**
 * Workspace sources matching `vscwclang.sourceGlobs`, minus `vscwclang.files.exclude`, minus detected build output
 * (folders holding CMake/Ninja marker files), so the background indexer does not parse build products. `.gitignore`
 * is deliberately not used: ignored files are often generated sources the project needs indexed.
 */
export async function discoverWorkspaceSources(): Promise<vscode.Uri[]> {
	const isExcluded = sourceExcluder();
	const found = new Map<string, vscode.Uri>();
	for (const glob of workspaceRelativeGlobs('sourceGlobs', ['**/*.{c,cc,cpp,cxx}'])) {
		for (const uri of await vscode.workspace.findFiles(glob, '**/node_modules/**')) { found.set(uri.toString(), uri); }
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { return [...found.values()]; }
	const isGenerated = makeSourceExcluder(await detectedOutputExclude(folder));
	return [...found.values()].filter(uri => { const relative = uri.path.slice(folder.path.length); return !isExcluded(relative) && !isGenerated(relative); });
}

async function detectedOutputExclude(folder: vscode.Uri): Promise<Record<string, boolean>> {
	const markers = await vscode.workspace.findFiles(`**/{${OUTPUT_FOLDER_MARKERS.join(',')}}`, '**/node_modules/**');
	return outputFolderExclude(markers.map(uri => uri.path.slice(folder.path.length)));
}

/**
 * The workspace-relative directory of the compilation database clangd will find on its own (`compile_commands.json`
 * at the root or in `build/`, the `vscwclang.compileCommands` setting, or `compile_flags.txt`), '' for the root, or
 * undefined if there is none. Overlay commands would shadow its entries, so the caller sends none then.
 */
export async function findCompilationDatabaseDir(folder: vscode.Uri, configured: string | undefined): Promise<string | undefined> {
	const candidates = [configured, 'compile_commands.json', 'build/compile_commands.json', 'compile_flags.txt'].filter((c): c is string => !!c);
	for (const relative of candidates) {
		try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, relative)); return relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''; } catch { /* not there */ }
	}
	return undefined;
}
