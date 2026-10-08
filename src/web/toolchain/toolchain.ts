import * as vscode from 'vscode';
import { Wasm, type MemoryFileSystem } from '@vscode/wasm-wasi';
import { parseDiagnostics, withFailureFallback, type ParsedDiagnostic } from './diagnostics';
import { checkUserFlags, splitFlags } from './flagPolicy';
import { GUEST_WORKSPACE, toGuestPath } from './guestPaths';
import { loadCompileFlags, loadSysroot, type SysrootFs } from './sysroot';
import { ToolchainStore, type StoreContext } from './toolchainStore';

export interface BuildRequest {
	/** Source files to compile; all must be inside the first workspace folder. */
	sources: vscode.Uri[];
	/** Where the linked .wasm goes: inside the first workspace folder, or anywhere else, in which case its directory is mounted at `/out`. */
	output: vscode.Uri;
	/** Extra user flags; restricted ones are rejected (see flagPolicy.ts). `-l`, `-L` and `-Wl,` flags go to wasm-ld, the rest to clang. */
	flags: string[];
	/** Extra flags for single sources, keyed by guest path (`/workspace/src/a.cpp`), added after `flags` with the same policy and routing. */
	sourceFlags?: Record<string, string[]>;
	/** "debug" adds -O0 -g (hook instrumentation and --export=__stack_pointer come with Milestone 4). */
	mode: 'debug' | 'release';
}

export interface BuildResult {
	/** 0 on success, else the exit code of the first failing clang/wasm-ld invocation. */
	exitCode: number;
	/** Combined compiler/linker output, in clang's text format. */
	diagnostics: string;
	parsed: ParsedDiagnostic[];
}

const SLICE = 'wasm32-wasip1';
const GUEST_OUT = '/out';

/**
 * Compiles each source with clang.wasm, then links with lld.wasm.
 *
 * Runs on `wasm-wasi-core`, one single-threaded process at a time (V1, see documents/design.md). Every
 * source is compiled even after an earlier one fails, so all diagnostics are reported; linking is skipped
 * when any compile fails. clang writes each object to stdout (`-o -`), the host stores it in an in-memory file
 * system, and wasm-ld reads it from there (mounted read-only at `/obj`), so nothing but the final output is
 * written to the workspace. Diagnostics carry guest paths (`/workspace/...`); use `guestPaths.fromGuestPath`
 * to map them back; linker messages name objects as `/obj/<n>-<file>.o`.
 *
 * Throws (rather than returning a nonzero result) for problems with the request itself.
 */
export async function build(request: BuildRequest, log: vscode.OutputChannel, context: StoreContext): Promise<BuildResult> {
	if (request.sources.length === 0) {
		throw new Error('vscwClang: no source files to build. Did you mean to add a .c/.cc/.cpp/.cxx file to the workspace?');
	}
	const problems = [request.flags, ...Object.values(request.sourceFlags ?? {})].flatMap(checkUserFlags);
	if (problems.length > 0) {
		throw new Error(`vscwClang: unsupported compiler flags:\n${problems.join('\n')}`);
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) {
		throw new Error('vscwClang: open a workspace folder first; sources and output are mapped under it as /workspace.');
	}
	const guest = (uri: vscode.Uri, what: string) => {
		const g = toGuestPath(folder.path, uri.path);
		if (g === undefined) {
			throw new Error(`vscwClang: ${what} ${uri.toString()} is outside the workspace folder ${folder.toString()}. Did you mean a path under it?`);
		}
		return g;
	};
	const sources = request.sources.map(uri => ({ uri, guest: guest(uri, 'source file') }));
	const outputInWorkspace = toGuestPath(folder.path, request.output.path) !== undefined && request.output.scheme === folder.scheme;
	const outputDir = vscode.Uri.joinPath(request.output, '..');
	const output = outputInWorkspace ? guest(request.output, 'output file') : `${GUEST_OUT}/${request.output.path.slice(request.output.path.lastIndexOf('/') + 1)}`;

	let diagnostics = '';
	let exitCode = 0;
	// First write to the workspace, before any first-use download: a local folder on vscode.dev may need a browser
	// permission prompt, which requires the user gesture that started the command and expires within seconds.
	await vscode.workspace.fs.createDirectory(outputDir);
	const toolchain = getToolchainStore(context, log);
	await toolchain.ensure();
	const wasm = await Wasm.load();
	const [flags, sysroot] = await Promise.all([loadCompileFlags(toolchain), getSysroot(wasm, toolchain)]);
	const sub = (f: string) => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
	const objects = await wasm.createMemoryFileSystem();
	const run = (wasmFile: string, args: string[], extra?: ToolExtras) => runTool(wasm, toolchain, sysroot, wasmFile, args, extra);
	const userFlags = splitFlags(request.flags, GUEST_WORKSPACE);
	const modeFlags = request.mode === 'debug' ? ['-O0', '-g'] : [];
	const ownFlags = new Map(sources.map(s => [s.guest, splitFlags(request.sourceFlags?.[s.guest] ?? [], GUEST_WORKSPACE)]));
	const linkFlags = [...new Set([...userFlags.link, ...[...ownFlags.values()].flatMap(f => f.link)])];
	const objectPaths: string[] = [];
	const abortShim = await addAbortShim(objects, (args, extra) => run('clang.wasm', args, extra), flags.compile[SLICE].map(sub), log);
	for (const [i, source] of sources.entries()) {
		const base = source.guest.slice(source.guest.lastIndexOf('/') + 1);
		const objectName = `${i}-${base}.o`;
		const driver = base.endsWith('.c') ? 'clang' : 'clang++';
		log.appendLine(`[vscwclang] compiling ${source.guest}`);
		const started = Date.now();
		const cc = await run('clang.wasm', [driver, ...flags.compile[SLICE].map(sub), '-fno-crash-diagnostics', '-fno-color-diagnostics', '-fno-caret-diagnostics',
			...modeFlags, ...userFlags.compile, ...ownFlags.get(source.guest)!.compile, '-c', source.guest, '-o', '-'], { captureStdout: true });
		log.appendLine(`[vscwclang] compiled ${source.guest} in ${Date.now() - started} ms (exit ${cc.exitCode})`);
		diagnostics += cc.stderr;
		if (cc.exitCode === 0) {
			objects.createFile(objectName, cc.stdout);
			objectPaths.push(`/obj/${objectName}`);
		} else if (exitCode === 0) {
			exitCode = cc.exitCode;
		}
	}
	if (exitCode === 0) {
		log.appendLine(`[vscwclang] linking ${output}`);
		const link = flags.link[SLICE].map(sub);
		const linkStarted = Date.now();
		const ld = await run('lld.wasm', ['wasm-ld', link[0], ...objectPaths, ...(abortShim ? [abortShim] : []), ...linkFlags, ...link.slice(1), '-o', output], { objects, outputDir: outputInWorkspace ? undefined : outputDir });
		log.appendLine(`[vscwclang] linked in ${Date.now() - linkStarted} ms (exit ${ld.exitCode})`);
		diagnostics += ld.stderr;
		exitCode = ld.exitCode;
	}
	return { exitCode, diagnostics, parsed: withFailureFallback(parseDiagnostics(diagnostics), exitCode, diagnostics) };
}

const NL = String.fromCharCode(10);

/**
 * Source of a weak `abort()` that exits with code 134 instead of trapping.
 *
 * wasm-wasi-core never settles `run()` when a program traps (vscode-wasm#303), and wasi-libc's `abort()`, so
 * `assert`, `std::terminate` and `abort` itself, is a trap. Weak, so a program's own `abort` still wins, and
 * linked ahead of libc so libc's copy is never pulled in. The same object holds a startup `chdir("/workspace")`,
 * since WASI has no working directory and relative paths otherwise fail. Direct traps (out-of-bounds, `__builtin_trap`) are not covered.
 */
export const ABORT_SHIM_SOURCE = [
	'#include <stdio.h>',
	'#include <wasi/api.h>',
	'#include <unistd.h>',
	'__attribute__((constructor)) static void vscwclang_chdir_workspace(void) { chdir("/workspace"); }',
	'__attribute__((weak, noreturn)) void abort(void) {',
	'\tfputs("abort() called", stderr);',
	'\tfputc(10, stderr);',
	'\t__wasi_proc_exit(134);',
	'}',
	'',
].join(NL);

let abortShimObject: Uint8Array<ArrayBuffer> | undefined;

/** Puts the compiled abort shim in `objects` and returns its guest path; undefined (build goes on) if it cannot be compiled. */
async function addAbortShim(objects: MemoryFileSystem, clang: (args: string[], extra: ToolExtras) => Promise<{ exitCode: number; stderr: string; stdout: Uint8Array<ArrayBuffer> }>, compileFlags: string[], log: vscode.OutputChannel): Promise<string | undefined> {
	if (!abortShimObject) {
		objects.createFile('vscwclang-abort.c', new TextEncoder().encode(ABORT_SHIM_SOURCE));
		const cc = await clang(['clang', ...compileFlags, '-fno-color-diagnostics', '-fno-caret-diagnostics', '-c', '/obj/vscwclang-abort.c', '-o', '-'], { captureStdout: true, objects });
		if (cc.exitCode !== 0) {
			log.appendLine(`[vscwclang] warning: could not build the abort() helper (exit ${cc.exitCode}); a failed assert will leave the program hanging until Ctrl+C. ${cc.stderr.trim()}`);
			return undefined;
		}
		abortShimObject = cc.stdout;
	}
	objects.createFile('vscwclang-abort.o', abortShimObject);
	return '/obj/vscwclang-abort.o';
}

// Caches survive across builds: unzipping the sysroot (~2 s) and compiling clang.wasm (~1 s) dominate small builds.
let sysrootPromise: Promise<SysrootFs> | undefined;
const modules = new Map<string, Promise<WebAssembly.Module>>();

let store: ToolchainStore | undefined;

/** The shared toolchain cache; `vscwclang.downloadToolchain` and every build go through it. */
export function getToolchainStore(context: StoreContext, log: vscode.OutputChannel): ToolchainStore {
	store ??= new ToolchainStore(context, log);
	return store;
}

function getSysroot(wasm: Wasm, toolchain: ToolchainStore): Promise<SysrootFs> {
	sysrootPromise ??= loadSysroot(wasm, toolchain).catch(e => { sysrootPromise = undefined; throw e; });
	return sysrootPromise;
}

function getModule(toolchain: ToolchainStore, wasmFile: string): Promise<WebAssembly.Module> {
	let module = modules.get(wasmFile);
	if (!module) {
		module = toolchain.getFile(wasmFile)
			.then(bits => WebAssembly.compile(bits))
			.catch(e => { modules.delete(wasmFile); throw e; });
		modules.set(wasmFile, module);
	}
	return module;
}

const DEFAULT_TOOL_TIMEOUT_SECONDS = 300;

/** 0 disables the timeout; invalid values fall back to the default. */
function toolTimeoutMs(): number {
	const seconds = vscode.workspace.getConfiguration('vscwclang').get<number>('toolTimeoutSeconds', DEFAULT_TOOL_TIMEOUT_SECONDS);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_TOOL_TIMEOUT_SECONDS * 1000;
}

interface ToolExtras {
	/** Keep stdout as bytes (clang `-o -`) instead of merging its text into the diagnostics. */
	captureStdout?: boolean;
	/** In-memory objects, mounted read-only at `/obj`. */
	objects?: MemoryFileSystem;
	/** A directory outside the workspace, mounted writable at `/out` (the link output). */
	outputDir?: vscode.Uri;
}

async function runTool(wasm: Wasm, toolchain: ToolchainStore, sysroot: SysrootFs, wasmFile: string, args: string[], extra: ToolExtras = {}): Promise<{ exitCode: number; stderr: string; stdout: Uint8Array<ArrayBuffer> }> {
	const module = await getModule(toolchain, wasmFile);
	const process = await wasm.createProcess(args[0], module, {
		args: args.slice(1),
		stdio: { out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } },
		mountPoints: [
			{ kind: 'workspaceFolder' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.sysroot, mountPoint: '/sysroot' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.resource, mountPoint: '/resource' },
			...(extra.objects ? [{ kind: 'memoryFileSystem' as const, fileSystem: extra.objects, mountPoint: '/obj' }] : []),
			...(extra.outputDir ? [{ kind: 'vscodeFileSystem' as const, uri: extra.outputDir, mountPoint: GUEST_OUT }] : []),
		],
	});
	const errDecoder = new TextDecoder();
	const outDecoder = new TextDecoder();
	let stderr = '';
	process.stderr?.onData(d => { stderr += errDecoder.decode(d, { stream: true }); });
	const stdoutChunks: Uint8Array[] = [];
	process.stdout?.onData(d => { if (extra.captureStdout) { stdoutChunks.push(new Uint8Array(d)); } else { stderr += outDecoder.decode(d, { stream: true }); } });
	// wasm-wasi-core's run() never settles if the tool traps (vscode-wasm#303); terminate() resolves it.
	let timedOut = false;
	const timeoutMs = toolTimeoutMs();
	const timer = timeoutMs === 0 ? undefined : setTimeout(() => { timedOut = true; void process.terminate(); }, timeoutMs);
	let exitCode: number;
	try {
		exitCode = await process.run();
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) {
		return { exitCode: 1, stderr: `${stderr}${args[0]}: error: no result after ${timeoutMs / 1000}s, so it was stopped (it probably crashed inside WebAssembly, or the source is very large). Did you mean to raise 'vscwclang.toolTimeoutSeconds'?
`, stdout: new Uint8Array(0) };
	}
	const stdout = new Uint8Array(stdoutChunks.reduce((n, c) => n + c.byteLength, 0));
	stdoutChunks.reduce((off, c) => { stdout.set(c, off); return off + c.byteLength; }, 0);
	return { exitCode, stderr, stdout };
}
