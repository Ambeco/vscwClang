import * as vscode from 'vscode';
import type { BuildOptions } from '../buildWorkspace';
import { linkOutputs, lowerToBuildRequest } from '../buildgraph/lower';
import { parseNinja } from '../buildgraph/ninjaParse';
import { buildGraphFromNinja, NinjaTraceError } from '../buildgraph/ninjaTrace';
import { GUEST_WORKSPACE } from '../toolchain/guestPaths';
import { inferHostRoot } from '../toolchain/projectModel';
import { buildOptionsFromLowered } from './makeBuild';

/**
 * Ninja support (CMake's Ninja generator, Meson): a `build.ninja` made elsewhere turned into a program the core builds
 * (design_project_model.md "Build graph"). Nothing here runs a process.
 *
 * `ninjaBuildOptions` finds `build.ninja` (the `vscwclang.ninja.buildDir` setting, else the folder root, `build`,
 * `out/build` and `out`), reads it and its `include`d files through the workspace file system, works out where the
 * folder sat on the machine that generated it (absolute paths in the file), builds the graph for the
 * `vscwclang.ninja.target` goal (default: the manifest's default targets), asks which linked program to build when
 * there are several, and lowers it. Errors carry did-you-mean text and are rethrown unchanged.
 */
const CANDIDATE_DIRS = ['', 'build', 'out/build', 'out'];
const INCLUDE = /^[ \t]*(?:include|subninja)[ \t]+(\S+)[ \t]*$/gm;

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).replace(/^﻿/, ''); } catch { return undefined; }
}

/** Reads `path` (workspace-relative) and, recursively, the files it includes, keyed by the paths `parseNinja` will ask for. */
async function preload(folder: vscode.Uri, path: string, files: Map<string, string>): Promise<boolean> {
	if (files.has(path)) { return true; }
	const text = await readText(vscode.Uri.joinPath(folder, path));
	if (text === undefined) { return false; }
	files.set(path, text);
	const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	for (const m of text.matchAll(INCLUDE)) {
		if (/[$]/.test(m[1])) { continue; }
		await preload(folder, dir === '' ? m[1] : `${dir}/${m[1]}`, files);
	}
	return true;
}

/** Plans a build of the first workspace folder's `build.ninja`; `cancelled` only when the user dismisses the program picker. */
export async function ninjaBuildOptions(log: vscode.OutputChannel): Promise<{ cancelled: boolean; build?: BuildOptions }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder before building from a build.ninja.'); }
	const config = vscode.workspace.getConfiguration('vscwclang');
	const configured = config.get<string>('ninja.buildDir', '').trim().replace(/^\/+|\/+$/g, '');
	const files = new Map<string, string>();
	let relDir: string | undefined;
	for (const dir of configured !== '' ? [configured] : CANDIDATE_DIRS) {
		if (await preload(folder, dir === '' ? 'build.ninja' : `${dir}/build.ninja`, files)) { relDir = dir; break; }
	}
	if (relDir === undefined) {
		throw new Error(`vscwClang: no build.ninja found in ${configured !== '' ? `'${configured}'` : 'the folder root, build, out/build or out'}. Did you mean to configure the project with CMake -G Ninja on a desktop and open the folder with its build directory, or to set vscwclang.ninja.buildDir?`);
	}
	const manifestPath = relDir === '' ? 'build.ninja' : `${relDir}/build.ninja`;
	{
		const manifest = parseNinja(files.get(manifestPath) as string, manifestPath, p => {
			const text = files.get(p);
			if (text === undefined) { throw new Error('it is not in the workspace folder'); }
			return text;
		});
		const known = new Set((await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx}', '**/node_modules/**')).map(u => u.path.slice(folder.path.length + 1)));
		const absoluteSources = manifest.edges.flatMap(e => e.inputs).filter(i => /^([A-Za-z]:)?\//.test(i) && /\.(c|cc|cpp|cxx)$/i.test(i));
		const hostRoot = inferHostRoot(absoluteSources.map(file => ({ file })), rel => known.has(rel)) ?? folder.path;
		const goal = config.get<string>('ninja.target', '').trim();
		const { graph, notes } = buildGraphFromNinja(manifest, { buildDir: relDir === '' ? hostRoot : `${hostRoot}/${relDir}`, hostRoot, goals: goal === '' ? undefined : [goal] });
		log.appendLine(`[vscwclang] ninja: ${manifestPath}, goal ${goal === '' ? '(default)' : goal}, folder was ${hostRoot}`);
		notes.forEach(n => log.appendLine(`[vscwclang] ninja: ${n}`));
		const programs = linkOutputs(graph);
		if (programs.length === 0) {
			throw new NinjaTraceError(`vscwClang: ${manifestPath} links no program for ${goal === '' ? 'its default target' : `'${goal}'`}. Did you mean to set vscwclang.ninja.target to the executable or test target?`);
		}
		let chosen = programs[0];
		if (programs.length > 1) {
			const pick = await vscode.window.showQuickPick(programs.map(p => ({ label: p.startsWith(`${GUEST_WORKSPACE}/`) ? p.slice(GUEST_WORKSPACE.length + 1) : p, program: p })), { title: 'vscwClang: which program should be built?' });
			if (!pick) { return { cancelled: true }; }
			chosen = pick.program;
		}
		const lowered = lowerToBuildRequest(graph, chosen);
		lowered.notes.forEach(n => log.appendLine(`[vscwclang] ninja: ${n}`));
		return { cancelled: false, build: buildOptionsFromLowered(lowered) };
	}
}
