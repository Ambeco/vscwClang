import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { parseDiagnostics, withFailureFallback, type ParsedDiagnostic } from './diagnostics';
import { checkUserFlags, splitFlags } from './flagPolicy';
import { GUEST_WORKSPACE, toGuestPath } from './guestPaths';
import { loadCompileFlags, loadSysroot, type SysrootFs } from './sysroot';
import { ToolchainStore, type StoreContext } from './toolchainStore';

export interface BuildRequest {
	/** Source files to compile; all must be inside the first workspace folder. */
	sources: vscode.Uri[];
	/** Where the linked .wasm goes; must be inside the first workspace folder. */
	output: vscode.Uri;
	/** Extra user flags; restricted ones are rejected (see flagPolicy.ts). `-l`, `-L` and `-Wl,` flags go to wasm-ld, the rest to clang. */
	flags: string[];
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

/**
 * Compiles each source with clang.wasm, then links with lld.wasm.
 *
 * Runs on `wasm-wasi-core`, one single-threaded process at a time (V1, see documents/design.md). Every
 * source is compiled even after an earlier one fails, so all diagnostics are reported; linking is skipped
 * when any compile fails. Objects go in a temporary `.vscwclang/obj` workspace folder (memory-FS mounts are
 * read-only to the guest, so `/tmp` is not an option), deleted when the build ends. Diagnostics carry
 * guest paths (`/workspace/...`); use `guestPaths.fromGuestPath` to map them back.
 *
 * Throws (rather than returning a nonzero result) for problems with the request itself.
 */
export async function build(request: BuildRequest, log: vscode.OutputChannel, context: StoreContext): Promise<BuildResult> {
	if (request.sources.length === 0) {
		throw new Error('vscwClang: no source files to build. Did you mean to add a .c/.cc/.cpp/.cxx file to the workspace?');
	}
	const problems = checkUserFlags(request.flags);
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
	const output = guest(request.output, 'output file');

	let diagnostics = '';
	let exitCode = 0;
	const objects: string[] = [];
	const objDir = vscode.Uri.joinPath(folder, '.vscwclang', 'obj');
	// First write to the workspace, before any first-use download: a local folder on vscode.dev may need a browser
	// permission prompt, which requires the user gesture that started the command and expires within seconds.
	await vscode.workspace.fs.createDirectory(objDir);
	try {
		const toolchain = getToolchainStore(context, log);
		await toolchain.ensure();
		const wasm = await Wasm.load();
		const [flags, sysroot] = await Promise.all([loadCompileFlags(toolchain), getSysroot(wasm, toolchain)]);
		const sub = (f: string) => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
		const run = (wasmFile: string, args: string[]) => runTool(wasm, toolchain, sysroot, wasmFile, args);
		const userFlags = splitFlags(request.flags, GUEST_WORKSPACE);
		const modeFlags = request.mode === 'debug' ? ['-O0', '-g'] : [];
		for (const [i, source] of sources.entries()) {
			const base = source.guest.slice(source.guest.lastIndexOf('/') + 1);
			const object = `${GUEST_WORKSPACE}/.vscwclang/obj/${i}-${base}.o`;
			const driver = base.endsWith('.c') ? 'clang' : 'clang++';
			log.appendLine(`[vscwclang] compiling ${source.guest}`);
			const cc = await run('clang.wasm', [driver, ...flags.compile[SLICE].map(sub), '-fno-crash-diagnostics', '-fno-color-diagnostics', '-fno-caret-diagnostics',
				...modeFlags, ...userFlags.compile, '-c', source.guest, '-o', object]);
			diagnostics += cc.stderr;
			objects.push(object);
			if (cc.exitCode !== 0 && exitCode === 0) { exitCode = cc.exitCode; }
		}
		if (exitCode === 0) {
			log.appendLine(`[vscwclang] linking ${output}`);
			const link = flags.link[SLICE].map(sub);
			const ld = await run('lld.wasm', ['wasm-ld', link[0], ...objects, ...userFlags.link, ...link.slice(1), '-o', output]);
			diagnostics += ld.stderr;
			exitCode = ld.exitCode;
		}
	} finally {
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, '.vscwclang'), { recursive: true, useTrash: false });
	}
	return { exitCode, diagnostics, parsed: withFailureFallback(parseDiagnostics(diagnostics), exitCode, diagnostics) };
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

async function runTool(wasm: Wasm, toolchain: ToolchainStore, sysroot: SysrootFs, wasmFile: string, args: string[]): Promise<{ exitCode: number; stderr: string }> {
	const module = await getModule(toolchain, wasmFile);
	const process = await wasm.createProcess(args[0], module, {
		args: args.slice(1),
		stdio: { out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } },
		mountPoints: [
			{ kind: 'workspaceFolder' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.sysroot, mountPoint: '/sysroot' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.resource, mountPoint: '/resource' },
		],
	});
	const errDecoder = new TextDecoder();
	const outDecoder = new TextDecoder();
	let stderr = '';
	process.stderr?.onData(d => { stderr += errDecoder.decode(d, { stream: true }); });
	process.stdout?.onData(d => { stderr += outDecoder.decode(d, { stream: true }); });
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
` };
	}
	return { exitCode, stderr };
}
