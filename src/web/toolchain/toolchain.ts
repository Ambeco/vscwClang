import * as vscode from 'vscode';
import { GuestProcess, StdinQueue } from '../host/guestProcess';
import { MemoryGuestFs } from '../host/memoryGuestFs';
import { VscodeGuestFs } from '../host/vscodeGuestFs';
import { sharedMemoryLimits, type MemoryLimits } from '../host/sharedMemory';
import { createGuestWorker, threadOptions } from '../host/workerHost';
import { parseDiagnostics, withFailureFallback, type ParsedDiagnostic } from './diagnostics';
import { DEFAULT_COMPILE_FLAGS, DEFAULT_C_COMPILE_FLAGS, DEFAULT_LINK_FLAGS } from './defaultFlags';
import { forEachLimited } from './concurrency';
import { checkUserFlags, splitFlags } from './flagPolicy';
import { GUEST_WORKSPACE, fromGuestPath, toGuestPath } from './guestPaths';
import { ObjectCache, defaultByteStore, hashText, splitIncludeTrace, type LinkRecord, type ReadGuestFile } from './objectCache';
import { pchRetryable, selectPch, type PchVariant } from './pch';
import { sha256Hex } from './toolchainDownload';
import { loadCompileFlags, loadSysrootGuestFs } from './sysroot';
import { chooseSlice } from './threadSlice';
import { ToolchainStore, type StoreContext } from './toolchainStore';
import { COVERAGE_IGNORELIST, COVERAGE_IGNORELIST_FILE } from '../debug/coverageIgnorelist';
import debugStubSource from '../debug/debugStub.c';

export interface BuildRequest {
	/** Source files to compile; all must be inside the first workspace folder. */
	sources: vscode.Uri[];
	/** Where the linked .wasm goes: inside the first workspace folder, or anywhere else, in which case its directory is mounted at `/out`. */
	output: vscode.Uri;
	/** Extra user flags; restricted ones are rejected (see flagPolicy.ts). `-l`, `-L` and `-Wl,` flags go to wasm-ld, the rest to clang. */
	flags: string[];
	/** Extra flags for single sources, keyed by guest path (`/workspace/src/a.cpp`), added after `flags` with the same policy and routing. */
	sourceFlags?: Record<string, string[]>;
	/** Flags for every C (`.c`) or C++ source respectively, placed before `flags` so those can override them. */
	languageFlags?: { c: string[]; cpp: string[] };
	/** "debug" adds -O0 -g, sancov instrumentation, and links the debug stub (debug/debugStub.c). */
	mode: 'debug' | 'release';
	/** Called after each source finishes compiling with every diagnostic so far, so errors can show before the build ends. */
	onDiagnostics?: (parsedSoFar: ParsedDiagnostic[]) => void;
}

export interface BuildResult {
	/** 0 on success, else the exit code of the first failing clang/wasm-ld invocation. */
	exitCode: number;
	/** Combined compiler/linker output, in clang's text format. */
	diagnostics: string;
	parsed: ParsedDiagnostic[];
}

/** Compiled objects (kept in the browser's Cache API) and link results (this session only), so an unchanged tree skips the build and an edit recompiles only what it touches. */
const objectCache = new ObjectCache(defaultByteStore('vscwclang-objects-v1'));
const lastLinks = new Map<string, LinkRecord>();

/** Drops every cached object and link result; the next build recompiles everything. */
export async function clearBuildCache(): Promise<void> {
	lastLinks.clear();
	await objectCache.clear();
}

/** Number of cached sources, distinct objects and their total bytes. */
export function buildCacheStats(): Promise<{ entries: number; objects: number; bytes: number }> {
	return objectCache.stats();
}
const GUEST_OUT = '/out';

/** What `build` needs from the extension context: toolchain storage, and the extension's files to start the Worker host. */
export type BuildContext = StoreContext & Pick<vscode.ExtensionContext, 'extensionUri'>;

/**
 * Compiles each source with clang.wasm, then links with lld.wasm.
 *
 * Runs each tool as its own process, one at a time, on the Worker host (documents/design.md "Host"). Every
 * source is compiled even after an earlier one fails, so all diagnostics are reported; linking is skipped
 * when any compile fails. clang writes each object to stdout (`-o -`), the host stores it in an in-memory file
 * system, and wasm-ld reads it from there (mounted read-only at `/obj`), so nothing but the final output is
 * written to the workspace. Diagnostics carry guest paths (`/workspace/...`); use `guestPaths.fromGuestPath`
 * to map them back; linker messages name objects as `/obj/<n>-<file>.o`.
 *
 * Throws (rather than returning a nonzero result) for problems with the request itself.
 */
export async function build(request: BuildRequest, log: vscode.OutputChannel, context: BuildContext): Promise<BuildResult> {
	const cacheSettings = vscode.workspace.getConfiguration('vscwclang.buildCache');
	objectCache.setLimits({ maxBytes: cacheSettings.get<number>('maxSizeMB', 1024) * 1048576, maxAgeMs: cacheSettings.get<number>('maxAgeDays', 7) * 24 * 3600 * 1000 });
	try {
		return await buildUncached(request, log, context);
	} finally {
		await objectCache.flush().catch(e => log.appendLine(`[vscwclang] warning: could not save the build cache: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function buildUncached(request: BuildRequest, log: vscode.OutputChannel, context: BuildContext): Promise<BuildResult> {
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
	const buildStarted = Date.now();
	const phases: string[] = [];
	let phaseStart = buildStarted;
	const endPhase = (name: string) => { const now = Date.now(); phases.push(`${name} ${now - phaseStart}`); phaseStart = now; };
	// First write to the workspace, before any first-use download: a local folder on vscode.dev may need a browser
	// permission prompt, which requires the user gesture that started the command and expires within seconds.
	await vscode.workspace.fs.createDirectory(outputDir);
	const toolchain = getToolchainStore(context, log);
	await toolchain.ensure(undefined, { userInitiated: true });
	endPhase('ensure');
	const flagsPromise = loadCompileFlags(toolchain);
	const guestSysroot = await loadSysrootGuestFs(toolchain);
	endPhase('sysroot');
	const objects = new MemoryGuestFs();
	const run = (wasmFile: string, args: string[], extra?: ToolExtras) => runTool(context, folder, toolchain, guestSysroot, wasmFile, args, extra);
	const flags = await flagsPromise;
	const slice = chooseSlice(Object.keys(flags.compile), vscode.workspace.getConfiguration('vscwclang').get<boolean>('threads', true), [request.flags, ...Object.values(request.sourceFlags ?? {})]);
	log.appendLine(`[vscwclang] building for ${slice}`);
	const sub = (f: string) => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
	const userFlags = splitFlags(request.flags, GUEST_WORKSPACE);
	// no-prune: by default sancov skips blocks it deems redundant, but a line breakpoint needs a guard at every block start.
	const modeFlags = request.mode === 'debug' ? ['-O0', '-g', '-fsanitize-coverage=trace-pc-guard,no-prune', ...(flags.debugCoverage ?? []), `-fsanitize-coverage-ignorelist=/obj/${COVERAGE_IGNORELIST_FILE}`] : [];
	if (request.mode === 'debug') { objects.setFile(COVERAGE_IGNORELIST_FILE, new TextEncoder().encode(COVERAGE_IGNORELIST)); }
	const ownFlags = new Map(sources.map(s => [s.guest, splitFlags(request.sourceFlags?.[s.guest] ?? [], GUEST_WORKSPACE)]));
	const linkFlags = [...new Set([...userFlags.link, ...[...ownFlags.values()].flatMap(f => f.link)])];
	const objectPaths: string[] = [];
	const clang = (args: string[], extra: ToolExtras) => run('clang.wasm', args, extra);
	const abortShim = await addShim(objects, clang, slice, flags.compile[slice].map(sub), log, ABORT_SHIM);
	const usesCpp = sources.some(s => !s.guest.endsWith('.c'));
	const uncaughtShim = usesCpp ? await addShim(objects, clang, slice, flags.compile[slice].map(sub), log, UNCAUGHT_SHIM) : undefined;
	const debugStub = request.mode === 'debug' ? await addShim(objects, clang, slice, flags.compile[slice].map(sub), log, DEBUG_STUB) : undefined;
	endPhase('shims');
	// Memoized for this build: every source validates its cached object by re-reading the headers it included, and
	// the same few headers are shared by most sources (each read is an RPC to the workbench).
	const reads = new Map<string, Promise<Uint8Array<ArrayBuffer> | undefined>>();
	const readGuest: ReadGuestFile = guestPath => {
		let read = reads.get(guestPath);
		if (!read) {
			const hostPath = fromGuestPath(folder.path, guestPath);
			read = hostPath === undefined ? Promise.resolve(undefined)
				: Promise.resolve(vscode.workspace.fs.readFile(folder.with({ path: hostPath }))).then(b => new Uint8Array(b), () => undefined);
			reads.set(guestPath, read);
		}
		return read;
	};
	const toolchainVersion = await toolchain.version();
	const pchSet = vscode.workspace.getConfiguration('vscwclang').get<boolean>('precompiledHeaders', true) ? flags.pch?.[slice] : undefined;
	const loadPch = async (variant: PchVariant): Promise<boolean> => {
		try {
			objects.setFile(variant.file, await getPchBytes(toolchain, toolchainVersion, variant.file));
			return true;
		} catch (e) {
			log.appendLine(`[vscwclang] warning: could not load the precompiled headers ${variant.file}; compiling without them. ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	};
	const cacheScope = `${folder.toString()}|${request.mode}|`;
	const stderrs: string[] = sources.map(() => '');
	const compiles: (CompiledSource | undefined)[] = [];
	const compileSource = async (source: (typeof sources)[number], i: number): Promise<CompiledSource> => {
		const base = source.guest.slice(source.guest.lastIndexOf('/') + 1);
		const objectName = `${i}-${base}.o`;
		const driver = base.endsWith('.c') ? 'clang' : 'clang++';
		const sourceBytes = await readGuest(source.guest);
		const sourceFlags = [...(request.languageFlags?.[driver === 'clang' ? 'c' : 'cpp'] ?? []), ...userFlags.compile, ...ownFlags.get(source.guest)!.compile];
		const choice = driver === 'clang++' && pchSet ? selectPch(pchSet, sourceFlags, sourceBytes && new TextDecoder().decode(sourceBytes)) : undefined;
		const pch = choice && 'variant' in choice ? choice.variant : undefined;
		const compileArgsWith = (usePch: PchVariant | undefined) => [driver, ...flags.compile[slice].map(sub), '-fno-crash-diagnostics', '-fno-color-diagnostics', '-fno-caret-diagnostics',
			...DEFAULT_COMPILE_FLAGS, ...(driver === 'clang' ? DEFAULT_C_COMPILE_FLAGS : []), ...modeFlags, ...(usePch ? ['-include-pch', `/obj/${usePch.file}`] : []), ...sourceFlags, '-c', source.guest];
		const compileArgs = compileArgsWith(pch);
		const cacheKey = cacheScope + source.guest;
		const argsKey = await hashText([toolchainVersion, ...compileArgs].join(NL));
		const sourceHash = sourceBytes && await sha256Hex(sourceBytes);
		const cached = sourceHash ? await objectCache.lookup(cacheKey, argsKey, sourceHash, readGuest) : undefined;
		if (cached) {
			log.appendLine(`[vscwclang] up to date ${source.guest} (reused object)`);
			stderrs[i] = cached.stderr;
			if (cached.stderr !== '') { request.onDiagnostics?.(parseDiagnostics(stderrs.join(''))); }
			objects.setFile(objectName, cached.object);
			return { exitCode: 0, objectPath: `/obj/${objectName}`, objectId: cached.id };
		}
		log.appendLine(`[vscwclang] compiling ${source.guest}`);
		const started = Date.now();
		// -H lists the included headers on stderr (stripped below); they decide when the cached object goes stale.
		let withPch = pch !== undefined && await loadPch(pch);
		let cc = withPch ? await run('clang.wasm', [...compileArgs, '-H', '-o', '-'], { captureStdout: true, objects }) : undefined;
		if (cc && cc.exitCode !== 0 && pchRetryable(cc.stderr)) {
			log.appendLine(`[vscwclang] ${source.guest}: the precompiled headers may be causing its errors; compiling again without them`);
			cc = undefined;
			withPch = false;
		}
		cc ??= await run('clang.wasm', [...compileArgsWith(undefined), '-H', '-o', '-'], { captureStdout: true, objects });
		log.appendLine(`[vscwclang] compiled ${source.guest} in ${Date.now() - started} ms (exit ${cc.exitCode}${withPch ? ', precompiled headers' : ''})`);
		const trace = splitIncludeTrace(cc.stderr, GUEST_WORKSPACE);
		stderrs[i] = trace.stderr;
		if (trace.stderr !== '') { request.onDiagnostics?.(parseDiagnostics(stderrs.join(''))); }
		if (cc.exitCode !== 0) { return { exitCode: cc.exitCode }; }
		objects.setFile(objectName, cc.stdout);
		const entry = sourceHash ? await objectCache.store(cacheKey, argsKey, sourceHash, trace.headers, cc.stdout, trace.stderr, readGuest) : undefined;
		return { exitCode: 0, objectPath: `/obj/${objectName}`, objectId: entry?.id };
	};
	await forEachLimited(sources, compileParallelism(sources.length), async (source, i) => { compiles[i] = await compileSource(source, i); });
	endPhase('sources');
	diagnostics += stderrs.join('');
	exitCode = compiles.find(c => c && c.exitCode !== 0)?.exitCode ?? 0;
	const objectIds = compiles.map(c => c?.objectId);
	objectPaths.push(...compiles.flatMap(c => c?.objectPath ? [c.objectPath] : []));
	if (exitCode === 0) {
		const link = flags.link[slice].map(sub);
		const linkArgs = ['wasm-ld', link[0], ...objectPaths, ...(abortShim ? [abortShim] : []), ...(uncaughtShim ? [uncaughtShim, '--wrap=__main_void'] : []), ...(debugStub ? [debugStub, '--export=__sanitizer_cov_trace_pc_guard'] : []), ...DEFAULT_LINK_FLAGS, ...linkFlags, ...link.slice(1), '-o', output];
		const linkKey = await hashText([toolchainVersion, request.output.toString(), objectIds.join(','), ...linkArgs].join(NL));
		const previous = lastLinks.get(request.output.toString());
		const outputStat = previous?.key === linkKey ? await vscode.workspace.fs.stat(request.output).then(s => s, () => undefined) : undefined;
		if (previous && outputStat && outputStat.mtime === previous.mtime && objectIds.every(id => id !== undefined)) {
			log.appendLine(`[vscwclang] up to date ${output} (nothing to compile or link)`);
			diagnostics += previous.stderr;
		} else {
			log.appendLine(`[vscwclang] linking ${output}`);
			const linkStarted = Date.now();
			const ld = await run('lld.wasm', linkArgs, { objects, outputDir: outputInWorkspace ? undefined : outputDir });
			log.appendLine(`[vscwclang] linked in ${Date.now() - linkStarted} ms (exit ${ld.exitCode})`);
			diagnostics += ld.stderr;
			exitCode = ld.exitCode;
			lastLinks.delete(request.output.toString());
			if (ld.exitCode === 0 && objectIds.every(id => id !== undefined)) {
				const stat = await vscode.workspace.fs.stat(request.output).then(s => s, () => undefined);
				if (stat) { lastLinks.set(request.output.toString(), { key: linkKey, mtime: stat.mtime, stderr: ld.stderr } satisfies LinkRecord); }
			}
		}
	}
	endPhase('link');
	log.appendLine(`[vscwclang] build phases (ms): ${phases.join(', ')}, total ${Date.now() - buildStarted}`);
	return { exitCode, diagnostics, parsed: withFailureFallback(parseDiagnostics(diagnostics), exitCode, diagnostics) };
}

interface CompiledSource { exitCode: number; objectPath?: string; objectId?: string }

/** Compiles run in parallel Workers; `vscwclang.parallelCompiles` (0 = automatic) caps how many, since each clang can need hundreds of MB. */
function compileParallelism(sourceCount: number): number {
	const setting = vscode.workspace.getConfiguration('vscwclang').get<number>('parallelCompiles', 0);
	const automatic = Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));
	return Math.max(1, Math.min(sourceCount, Number.isFinite(setting) && setting > 0 ? Math.floor(setting) : automatic));
}

const NL = String.fromCharCode(10);

/**
 * Source of a weak `abort()` that exits with code 134 (SIGABRT) instead of trapping.
 *
 * wasi-libc's `abort()`, so `assert`, `std::terminate` and `abort` itself, is a trap, which the host reports as a
 * crash (exit 139). Weak, so a program's own `abort` still wins, and linked ahead of libc so libc's copy is never
 * pulled in. The same object holds a startup `chdir("/workspace")`, since WASI has no working directory and
 * relative paths otherwise fail.
 */
const ABORT_SHIM_SOURCE = [
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

interface Shim { name: string; source: string; flags: string[]; failure: string; cxx?: boolean }

/**
 * Source of a wrapper around `main` that sends an uncaught C++ exception to `std::terminate` from inside a `catch`.
 *
 * With `-fwasm-exceptions` a `throw` nothing catches leaves `_start` as a raw wasm exception instead of reaching
 * `std::terminate`. libc++abi's terminate handler, called inside the catch, prints the exception's type and
 * `what()`, then `abort()` exits 134. Linked with `--wrap=__main_void`: `crt1`'s `_start` calls `__main_void`, which libc
 * defines for `main(argc, argv)` and the compiler defines in the program's own object for `main()`.
 * Throws outside `main` (static constructors) still escape; the host reports those without a type.
 */
const UNCAUGHT_SHIM_SOURCE = [
	'#include <exception>',
	'extern "C" int __real___main_void(void);',
	'extern "C" int __wrap___main_void(void) {',
	'	try { return __real___main_void(); } catch (...) { std::terminate(); }',
	'}',
	'',
].join(NL);

const UNCAUGHT_SHIM: Shim = { name: 'uncaught', source: UNCAUGHT_SHIM_SOURCE, flags: [], failure: 'an uncaught C++ exception will end as a crash without its type and message', cxx: true };
const ABORT_SHIM: Shim = { name: 'abort', source: ABORT_SHIM_SOURCE, flags: [], failure: 'a failed assert will end as a crash instead of exit code 134' };
// Compiled without sancov (the stub is the hook), at -O2 because it runs on every basic block.
const DEBUG_STUB: Shim = { name: 'debugstub', source: debugStubSource, flags: ['-O2'], failure: 'breakpoints will not work' };

const shimObjects = new Map<string, Uint8Array<ArrayBuffer>>();

/** Puts the compiled shim in `objects` and returns its guest path; undefined (build goes on) if it cannot be compiled. */
async function addShim(objects: MemoryGuestFs, clang: (args: string[], extra: ToolExtras) => Promise<ToolResult>, slice: string, compileFlags: string[], log: vscode.OutputChannel, shim: Shim): Promise<string | undefined> {
	const cacheKey = `${slice}/${shim.name}`;
	let object = shimObjects.get(cacheKey);
	if (!object) {
		const sourceName = `vscwclang-${shim.name}.${shim.cxx ? 'cpp' : 'c'}`;
		objects.setFile(sourceName, new TextEncoder().encode(shim.source));
		const cc = await clang([shim.cxx ? 'clang++' : 'clang', ...compileFlags, ...shim.flags, '-fno-color-diagnostics', '-fno-caret-diagnostics', '-c', `/obj/${sourceName}`, '-o', '-'], { captureStdout: true, objects });
		if (cc.exitCode !== 0) {
			log.appendLine(`[vscwclang] warning: could not build the ${shim.name} helper (exit ${cc.exitCode}); ${shim.failure}. ${cc.stderr.trim()}`);
			return undefined;
		}
		object = cc.stdout;
		shimObjects.set(cacheKey, object);
	}
	objects.setFile(`vscwclang-${shim.name}.o`, object);
	return `/obj/vscwclang-${shim.name}.o`;
}

let loadedPch: { key: string; bytes: Promise<Uint8Array<ArrayBuffer>> } | undefined;

/** The PCH file's verified bytes; only the latest is kept (a PCH is ~15 MB), and a failed download is not remembered. */
function getPchBytes(toolchain: ToolchainStore, toolchainVersion: string, file: string): Promise<Uint8Array<ArrayBuffer>> {
	const key = `${toolchainVersion}/${file}`;
	if (loadedPch?.key !== key) {
		const bytes = toolchain.getFile(file);
		bytes.catch(() => { if (loadedPch?.bytes === bytes) { loadedPch = undefined; } });
		loadedPch = { key, bytes };
	}
	return loadedPch.bytes;
}

// Compiling clang.wasm (~1 s) dominates small builds, so compiled modules survive across builds.
const modules = new Map<string, Promise<{ module: WebAssembly.Module; limits: MemoryLimits | undefined }>>();

const stores = new Map<string, ToolchainStore>();

/** The shared toolchain cache for `context.globalStorageUri`; `vscwclang.downloadToolchain` and every build go through it. */
export function getToolchainStore(context: StoreContext, log: vscode.OutputChannel): ToolchainStore {
	const key = context.globalStorageUri.toString();
	let store = stores.get(key);
	if (!store) {
		store = new ToolchainStore(context, log);
		store.backgroundPrefetch = true;
		// Compiling a tool takes seconds; start as soon as its file is cached (in parallel with the next download), not on first use.
		const warm = store;
		store.onDidHaveFile(file => { if (WARM_MODULES.includes(file)) { void getModule(warm, file).catch(() => undefined); } });
		stores.set(key, store);
	}
	return store;
}

const WARM_MODULES = ['clangd.wasm', 'clang.wasm', 'lld.wasm'];

/** The compiled module of a toolchain `.wasm` (plus its shared-memory limits), compiled once per session and shared by every caller. */
export function getModule(toolchain: ToolchainStore, wasmFile: string): Promise<{ module: WebAssembly.Module; limits: MemoryLimits | undefined }> {
	let module = modules.get(wasmFile);
	if (!module) {
		module = toolchain.getFile(wasmFile)
			.then(async bits => ({ module: await WebAssembly.compile(bits), limits: sharedMemoryLimits(bits) }))
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

type ToolResult = { exitCode: number; stderr: string; stdout: Uint8Array<ArrayBuffer> };

interface ToolExtras {
	/** Keep stdout as bytes (clang `-o -`) instead of merging its text into the diagnostics. */
	captureStdout?: boolean;
	/** Compiled objects (and shim sources) in memory, mounted read-only at `/obj`. */
	objects?: MemoryGuestFs;
	/** A directory outside the workspace, mounted writable at `/out` (the link output). */
	outputDir?: vscode.Uri;
}

/**
 * Runs one tool in its own Worker. Traps and timeouts end the tool with exit code 1 and a message in `stderr`.
 */
async function runTool(context: BuildContext, workspace: vscode.Uri, toolchain: ToolchainStore, sysroot: { sysroot: MemoryGuestFs; resource: MemoryGuestFs }, wasmFile: string, args: string[], extra: ToolExtras = {}): Promise<ToolResult> {
	const { module, limits } = await getModule(toolchain, wasmFile);
	const worker = await createGuestWorker(context as vscode.ExtensionContext);
	const mounts = [
		{ guestPath: GUEST_WORKSPACE, uri: workspace },
		{ guestPath: '/sysroot', fs: sysroot.sysroot },
		{ guestPath: '/resource', fs: sysroot.resource },
		...(extra.objects ? [{ guestPath: '/obj', fs: extra.objects }] : []),
		...(extra.outputDir ? [{ guestPath: GUEST_OUT, uri: extra.outputDir }] : []),
	];
	const stdin = new StdinQueue();
	stdin.end();
	const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
	let stderr = '';
	const stdoutChunks: Uint8Array[] = [];
	const guest = new GuestProcess({
		module, args: limits && wasmFile === 'clang.wasm' ? [args[0], '-fintegrated-cc1', ...args.slice(1)] : args, env: {}, preopens: mounts.map(m => m.guestPath), fs: new VscodeGuestFs(mounts), stdin,
		onOutput: (fd, data) => {
			if (fd === 1 && extra.captureStdout) { stdoutChunks.push(new Uint8Array(data)); } else { stderr += decoders[fd].decode(data, { stream: true }); }
		},
		createWorker: () => worker,
		...threadOptions(context as vscode.ExtensionContext, limits),
	});
	const timeoutMs = toolTimeoutMs();
	const timer = timeoutMs === 0 ? undefined : setTimeout(() => guest.terminate(), timeoutMs);
	let outcome;
	try {
		outcome = await guest.run();
	} finally {
		clearTimeout(timer);
	}
	let exitCode: number;
	switch (outcome.kind) {
		case 'exit': exitCode = outcome.code; break;
		case 'trap': exitCode = 1; stderr += `${args[0]}: error: crashed inside WebAssembly: ${outcome.message}
`; break;
		case 'terminated': exitCode = 1; stderr += `${args[0]}: error: no result after ${timeoutMs / 1000}s, so it was stopped (the source may be very large). Did you mean to raise 'vscwclang.toolTimeoutSeconds'?
`; break;
		case 'failed': exitCode = 1; stderr += `${args[0]}: error: could not run: ${outcome.message}
`; break;
	}
	const stdout = new Uint8Array(stdoutChunks.reduce((n, c) => n + c.byteLength, 0));
	stdoutChunks.reduce((off, c) => { stdout.set(c, off); return off + c.byteLength; }, 0);
	return { exitCode, stderr, stdout };
}
