import * as vscode from 'vscode';
import { sourceExcluder, workspaceRelativeGlobs } from '../projectConfig';
import type { IndexTarget } from '../toolchain/indexTargets';
import { OUTPUT_FOLDER_MARKERS, makeSourceExcluder, outputFolderExclude } from '../toolchain/sourceFilter';

/**
 * Workspace sources matching `vscwclang.sourceGlobs`, minus `vscwclang.files.exclude`, minus detected build output
 * (folders holding CMake/Ninja marker files), so the background indexer does not parse build products. `.gitignore`
 * is deliberately not used: ignored files are often generated sources the project needs indexed. Used only when
 * `tasks.json` names no buildable sources (`discoverTargetSources`).
 */
export async function discoverWorkspaceSources(): Promise<vscode.Uri[]> {
	const found = new Map<string, vscode.Uri>();
	for (const glob of workspaceRelativeGlobs('sourceGlobs', ['**/*.{c,cc,cpp,cxx}'])) {
		for (const uri of await vscode.workspace.findFiles(glob, '**/node_modules/**')) { found.set(uri.toString(), uri); }
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { return [...found.values()]; }
	const isExcluded = await workspaceExcluder(folder);
	return [...found.values()].filter(uri => !isExcluded(uri.path.slice(folder.path.length)));
}

/** A source a `tasks.json` build compiles, with the flags that build gives it. */
export interface TargetSource {
	uri: vscode.Uri;
	flags: string[];
}

/**
 * The files the workspace's build tasks compile, each with the flags of the first task that names it. Globs are
 * excluded like `discoverWorkspaceSources` does; a task naming a file without wildcards always includes it.
 */
export async function discoverTargetSources(targets: readonly IndexTarget[]): Promise<TargetSource[]> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const isExcluded = folder ? await workspaceExcluder(folder) : () => false;
	const found = new Map<string, TargetSource>();
	for (const target of targets) {
		for (const glob of target.sources) {
			const wildcard = /[*?[\]{}]/.test(glob);
			for (const uri of await vscode.workspace.findFiles(glob, '**/node_modules/**')) {
				if (found.has(uri.toString()) || (wildcard && folder && isExcluded(uri.path.slice(folder.path.length)))) { continue; }
				found.set(uri.toString(), { uri, flags: target.flags });
			}
		}
	}
	return [...found.values()];
}

async function workspaceExcluder(folder: vscode.Uri): Promise<(relativePath: string) => boolean> {
	const isExcluded = sourceExcluder();
	const isGenerated = makeSourceExcluder(await detectedOutputExclude(folder));
	return relative => isExcluded(relative) || isGenerated(relative);
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
