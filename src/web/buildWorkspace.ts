import * as vscode from 'vscode';
import { DEFAULT_EXCLUDED_DIRS, isExcludedSource } from './toolchain/sourceFilter';
import { artifactsBelongInFolder, artifactSubdir, storageKeyFor } from './toolchain/artifactPolicy';
import { build, type BuildResult } from './toolchain/toolchain';

export interface WorkspaceBuild {
	folder: vscode.Uri;
	output: vscode.Uri;
	result: BuildResult;
}

export interface BuildOptions {
	sourceGlobs?: string[];
	/** Workspace-relative output path; overrides the artifact location. */
	outputName?: string;
	/** File name for the .wasm inside the artifact directory (unlike `outputName`, works on read-only folders). */
	artifactName?: string;
	flags?: string[];
	mode?: 'debug' | 'release';
}

/**
 * Builds the C/C++ sources found under the first workspace folder into `outputName`.
 *
 * The `.wasm` and `build.log` go to `.vscwclang/<mode>/` in the folder, or to extension storage when the folder
 * is read-only or virtual (see `chooseArtifactDir`); an explicit `outputName` (workspace-relative) overrides that.
 *
 * Sources come from `sourceGlobs` (default: the `vscwclang.sourceGlobs` setting), minus any file under a directory
 * named in `vscwclang.sourceExclude` (IDE scratch and build-output folders by default). A glob without wildcards
 * names one file: it is never excluded, and it is an error if it does not exist.
 */
export async function buildWorkspace(context: vscode.ExtensionContext, log: vscode.OutputChannel, options: BuildOptions = {}): Promise<WorkspaceBuild> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder first.'); }
	const mode = options.mode ?? 'release';
	const artifactDir = await chooseArtifactDir(context, folder, mode);
	const output = options.outputName !== undefined ? vscode.Uri.joinPath(folder, options.outputName) : vscode.Uri.joinPath(artifactDir, options.artifactName ?? 'a.out.wasm');
	const found = new Map<string, vscode.Uri>();
	const explicit = new Map<string, vscode.Uri>();
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const excluded = settings.get<string[]>('sourceExclude', DEFAULT_EXCLUDED_DIRS);
	for (const glob of options.sourceGlobs ?? settings.get<string[]>('sourceGlobs', ['**/*.{c,cc,cpp,cxx}'])) {
		const matches = await vscode.workspace.findFiles(glob, '**/node_modules/**');
		if (!/[*?[\]{}]/.test(glob)) {
			if (matches.length === 0) { throw new Error(`vscwClang: source file '${glob}' was not found in the workspace folder. Did you mean a path relative to the folder, such as 'src/${glob.slice(glob.lastIndexOf('/') + 1)}'?`); }
			matches.forEach(uri => explicit.set(uri.toString(), uri));
		}
		for (const uri of matches) { found.set(uri.toString(), uri); }
	}
	// findFiles' exclude glob is not honored on every virtual file system (seen under test-web), so filter ourselves.
	const sources = [...found.values()].filter(uri => explicit.has(uri.toString()) || !isExcludedSource(uri.path.slice(folder.path.length), excluded));
	log.appendLine(`[vscwclang] ${sources.length} source file(s) found (skipping directories named: ${excluded.join(', ')})`);
	const result = await build({ sources, output, flags: options.flags ?? settings.get<string[]>('flags', []), mode }, log, context);
	log.appendLine(result.diagnostics);
	await writeBuildLog(vscode.Uri.joinPath(output, '..'), result);
	return { folder, output, result };
}

/**
 * Directory for one mode's build artifacts: `.vscwclang/<mode>/` in the folder if it is writable, else a per-folder
 * directory in extension storage. A folder whose writability is unknown is tried, and falls back on failure.
 */
export async function chooseArtifactDir(context: vscode.ExtensionContext, folder: vscode.Uri, mode: 'debug' | 'release'): Promise<vscode.Uri> {
	if (artifactsBelongInFolder(folder.scheme, vscode.workspace.fs.isWritableFileSystem(folder.scheme))) {
		const inFolder = vscode.Uri.joinPath(folder, artifactSubdir(mode));
		try {
			// First write to the workspace: see the note in toolchain.build about the browser permission prompt.
			await vscode.workspace.fs.createDirectory(inFolder);
			return inFolder;
		} catch {
			// fall through to extension storage
		}
	}
	const inStorage = vscode.Uri.joinPath(context.globalStorageUri, 'artifacts', storageKeyFor(folder.toString()), mode);
	await vscode.workspace.fs.createDirectory(inStorage);
	return inStorage;
}

async function writeBuildLog(dir: vscode.Uri, result: BuildResult): Promise<void> {
	const text = `exit code ${result.exitCode}
${result.diagnostics}`;
	try {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'build.log'), new TextEncoder().encode(text));
	} catch (e) {
		console.warn(`vscwClang: could not write build.log in ${dir.toString()}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
