import * as vscode from 'vscode';
import type { BuildOptions } from '../buildWorkspace';
import { BuildGraphError } from '../buildgraph/graph';
import { linkOutputs, lowerToBuildRequest, LowerError, type LoweredBuild } from '../buildgraph/lower';
import { buildGraphFromMake, MakeTraceError } from '../buildgraph/makeTrace';
import { GuestProcess, StdinQueue } from '../host/guestProcess';
import { VscodeGuestFs } from '../host/vscodeGuestFs';
import { createGuestWorker } from '../host/workerHost';
import { GUEST_WORKSPACE } from '../toolchain/guestPaths';
import { MakePack } from './makePack';

/**
 * Make support: a `make` dry run turned into a program the core builds (design_project_model.md "Build graph").
 *
 * `makeBuildOptions` runs `make -n -B --trace -C /workspace [goal]` as a tool guest (only `/workspace` mounted, empty
 * environment, no process model: `$(shell)` and `$(MAKE)` are refused with a did-you-mean), reads the output into a
 * build graph, asks which linked program to build when there are several, and returns the lowered
 * `BuildOptions` for `buildWorkspace`. The `make.wasm` pack is downloaded on first use. Nothing here is
 * imported by the core; extension.ts loads it only when a Make command runs.
 */
const DRY_RUN_TIMEOUT_MS = 120_000;

/** Runs make's dry run and returns its combined output; throws if make could not run or failed outright. */
export async function runMakeDryRun(context: vscode.ExtensionContext, makeWasm: Uint8Array<ArrayBuffer>, workspace: vscode.Uri, goal: string | undefined, directory = ''): Promise<string> {
	const mounts = [{ guestPath: GUEST_WORKSPACE, uri: workspace }];
	const stdin = new StdinQueue();
	stdin.end();
	const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
	let output = '';
	const worker = await createGuestWorker(context);
	const guest = new GuestProcess({
		module: await WebAssembly.compile(makeWasm),
		args: ['make', '-n', '-B', '--trace', '-C', directory ? `${GUEST_WORKSPACE}/${directory}` : GUEST_WORKSPACE, ...(goal ? [goal] : [])],
		env: {}, preopens: mounts.map(m => m.guestPath), fs: new VscodeGuestFs(mounts), stdin,
		onOutput: (fd, data) => { output += decoders[fd].decode(data, { stream: true }); },
		createWorker: () => worker,
	});
	const timer = setTimeout(() => guest.terminate(), DRY_RUN_TIMEOUT_MS);
	const outcome = await guest.run().finally(() => clearTimeout(timer));
	switch (outcome.kind) {
		case 'exit': break;
		case 'trap': throw new Error(`vscwClang: make crashed inside WebAssembly (${outcome.message}). Did you mean to report this with the Makefile that triggered it?`);
		case 'terminated': throw new Error(`vscwClang: make's dry run had no result after ${DRY_RUN_TIMEOUT_MS / 1000}s and was stopped. Did you mean a Makefile with fewer includes or generated rules?`);
		case 'failed': throw new Error(`vscwClang: make could not run: ${outcome.message}`);
	}
	// A nonzero exit still carries the useful text (`*** No rule to make target`); the trace reader reports it as a problem.
	return output;
}

/** The workspace-relative `BuildOptions` for a lowered program; its output name is the make target's, with `.wasm`. */
export function buildOptionsFromLowered(lowered: LoweredBuild): BuildOptions {
	const workspacePrefix = `${GUEST_WORKSPACE}/`;
	return {
		sourceFiles: lowered.sources,
		sourceFlags: Object.fromEntries(Object.entries(lowered.sourceFlags).map(([guest, flags]) => [guest.startsWith(workspacePrefix) ? guest.slice(workspacePrefix.length) : guest, flags])),
		flags: lowered.flags,
		artifactName: `${lowered.output.replace(/^.*\//, '')}.wasm`,
		mode: lowered.mode,
	};
}

/**
 * Plans a Make build of the first workspace folder: dry run, graph, program choice, lowering.
 *
 * `goal` defaults to the `vscwclang.make.goal` setting, then to make's own default goal; `directory` (workspace-relative) is where make runs. Cancelled only when the user dismisses the program picker.
 * Errors from the trace reader or lowering carry did-you-mean text and are rethrown unchanged.
 */
export async function makeBuildOptions(context: vscode.ExtensionContext, log: vscode.OutputChannel, pack: MakePack, options: { goal?: string; directory?: string } = {}): Promise<{ cancelled: boolean; build?: BuildOptions }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { throw new Error('vscwClang: open a workspace folder before building with Make.'); }
	const makeGoal = options.goal ?? (vscode.workspace.getConfiguration('vscwclang').get<string>('make.goal', '').trim() || undefined);
	const makeWasm = await pack.getMakeWasm();
	log.appendLine(`[vscwclang] make -n -B --trace ${makeGoal ?? '(default goal)'}`);
	const text = await runMakeDryRun(context, makeWasm, folder, makeGoal, options.directory);
	try {
		const { graph, notes } = buildGraphFromMake(text, GUEST_WORKSPACE);
		notes.forEach(n => log.appendLine(`[vscwclang] make: ${n}`));
		const programs = linkOutputs(graph);
		if (programs.length === 0) {
			throw new MakeTraceError(`vscwClang: \`make ${makeGoal ?? ''}\` links no program. Did you mean to set vscwclang.make.goal to the target that builds your executable (for example \`all\` or \`test\`)?`);
		}
		let chosen = programs[0];
		if (programs.length > 1) {
			const pick = await vscode.window.showQuickPick(programs.map(p => ({ label: p.startsWith(`${GUEST_WORKSPACE}/`) ? p.slice(GUEST_WORKSPACE.length + 1) : p, program: p })), { title: 'vscwClang: which program should be built?' });
			if (!pick) { return { cancelled: true }; }
			chosen = pick.program;
		}
		const lowered = lowerToBuildRequest(graph, chosen);
		lowered.notes.forEach(n => log.appendLine(`[vscwclang] make: ${n}`));
		return { cancelled: false, build: buildOptionsFromLowered(lowered) };
	} catch (e) {
		if (e instanceof MakeTraceError || e instanceof LowerError || e instanceof BuildGraphError) { log.appendLine(`[vscwclang] make dry run output:\n${text}`); }
		throw e;
	}
}
