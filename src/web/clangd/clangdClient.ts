import * as vscode from 'vscode';
import { sharedMemoryLimits } from '../host/sharedMemory';
import { createWorkerProcess, type PipedProcess } from '../host/workerProcess';
import { LanguageClient, ReadableStreamMessageReader, WriteableStreamMessageWriter, type LanguageClientOptions, type MessageTransports } from 'vscode-languageclient/browser';
import { loadCompileFlags, loadSysrootFiles, loadSysrootGuestFs } from '../toolchain/sysroot';
import { fallbackFlags } from './fallbackFlags';
import { getToolchainStore } from '../toolchain/toolchain';
import { chooseSlice } from '../toolchain/threadSlice';
import { GUEST_WORKSPACE, TOOLCHAIN_SCHEME, fromGuestPath, isToolchainGuestPath, toGuestPath } from '../toolchain/guestPaths';
import { ToolchainFileSystem } from '../toolchain/toolchainFileSystem';
import { clangdLogLevel, compileCommandsPath, logsClangdStderr } from '../toolchain/cppToolsSettings';
import { intelliSenseEnabled, loggingLevel, projectSettings, userFlags } from '../projectConfig';
import { GUEST_CACHE, OVERLAY_BATCH_SIZE, batches, clangdArgs, clangdThreadCount, compilationDatabaseChanges, shardMountPoint } from './clangdConfig';
import { discoverWorkspaceSources, findCompilationDatabaseDir } from './compileOverlay';

const CLANGD_TMP = 'clangd-tmp';
const CLANGD_CACHE = 'clangd-cache';
/**
 * Starts clangd.wasm as a long-lived process on the Worker host and wires it to VS Code's language-client
 * machinery, so completion/hover/go-to-definition/diagnostics come from clangd instead of nothing.
 *
 * clangd.wasm is a normal toolchain-manifest entry (published at the pinned tag alongside clang.wasm/lld.wasm;
 * see the `Ambeco/llvm-artifacts` release), downloaded and cached the same way. It is the wasi-threads build, so
 * clangd runs its own parser pool and background indexer on Workers. The indexer only knows files that have compile
 * commands, so unless the project has a compilation database the workspace sources are sent as
 * `compilationDatabaseChanges` (`compileOverlay.ts`), and new files as they are created. Index shards persist in a
 * per-workspace folder of extension storage, mounted at `/cache` (`XDG_CACHE_HOME`) and, with a compilation
 * database, over the `<root>/.cache/clangd` where clangd insists on writing them, so the user's folder (possibly
 * read-only) is never touched. Indexing progress is clangd's own work-done progress notification.
 *
 * Only one client may be live per extension host: the server's commands (`clangd.applyFix`, ...) are registered
 * globally, so a second client fails to initialize. The test workspace turns the activation client off
 * (`.vscode/settings.json`) so a test can start its own, with `ignoreIntelliSenseSetting`.
 */
export async function startClangdClient(context: vscode.ExtensionContext, log: vscode.OutputChannel, options: { ignoreIntelliSenseSetting?: boolean } = {}): Promise<vscode.Disposable | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) { return undefined; }
	if (!options.ignoreIntelliSenseSetting && !intelliSenseEnabled()) {
		log.appendLine('[vscwclang] IntelliSense is off (vscwclang.intelliSense.enabled, or C_Cpp.intelliSenseEngine: disabled); clangd was not started. Reload the window after changing it.');
		return undefined;
	}
	const level = loggingLevel();

	const toolchain = getToolchainStore(context, log);
	const [bits, sysrootFiles, flags] = await Promise.all([toolchain.getFile('clangd.wasm'), loadSysrootFiles(toolchain), loadCompileFlags(toolchain)]);
	const extraFlags = userFlags(log, true).flags;
	// The same slice Build picks, or <thread> and <mutex> would be errors here but not there.
	const compileFlags = flags.compile[chooseSlice(Object.keys(flags.compile), vscode.workspace.getConfiguration('vscwclang').get<boolean>('threads', true), [extraFlags])].map(f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource'));
	const module = await WebAssembly.compile(bits);
	const memoryLimits = sharedMemoryLimits(bits);
	if (!memoryLimits) {
		throw new Error('vscwClang: the downloaded clangd.wasm is the single-threaded build, which no longer has an indexing fallback. Did you mean to use a toolchain published from build-clangd-threads (see scripts/make-toolchain-dist.mjs)?');
	}

	const tmpDir = vscode.Uri.joinPath(context.globalStorageUri, CLANGD_TMP);
	const cacheDir = vscode.Uri.joinPath(context.globalStorageUri, CLANGD_CACHE, await workspaceKey(folder));
	await vscode.workspace.fs.createDirectory(tmpDir);
	await vscode.workspace.fs.createDirectory(cacheDir);
	const configured = compileCommandsPath(projectSettings('vscwclang').get<unknown>('compileCommands')) ?? compileCommandsPath(projectSettings('C_Cpp').get<unknown>('default.compileCommands'));
	const databaseDir = await findCompilationDatabaseDir(folder, configured);
	const shardMount = databaseDir === undefined ? undefined : shardMountPoint(databaseDir);

	const args = clangdArgs(clangdLogLevel(level), clangdThreadCount(globalThis.navigator?.hardwareConcurrency));
	const sysroot = await loadSysrootGuestFs(toolchain);
	const process = await createWorkerProcess(context, {
		name: 'clangd', module, args, env: { XDG_CACHE_HOME: GUEST_CACHE }, memoryLimits,
		mounts: [
			{ guestPath: GUEST_WORKSPACE, uri: folder },
			{ guestPath: '/sysroot', fs: sysroot.sysroot },
			{ guestPath: '/resource', fs: sysroot.resource },
			{ guestPath: '/tmp', uri: tmpDir },
			{ guestPath: GUEST_CACHE, uri: cacheDir },
			...(shardMount ? [{ guestPath: shardMount, uri: cacheDir }] : []),
		],
	});
	const stderrChunks: string[] = [];
	process.stderr?.onData(d => {
		const text = new TextDecoder().decode(d);
		stderrChunks.push(text);
		if (logsClangdStderr(level)) { log.append(text); }
	});
	const exited = process.run();
	const transports = makeMessageTransports(process, exited, log);
	const stderrTail = () => stderrChunks.join('').slice(-800);
	void exited.then(
		code => { if (code !== 0) { log.appendLine(`[vscwclang] clangd exited unexpectedly (code ${code}): ${stderrTail()}`); } },
		e => log.appendLine(`[vscwclang] clangd could not run: ${errorText(e)} ${stderrTail()}`));

	const toolchainFs = vscode.workspace.registerFileSystemProvider(TOOLCHAIN_SCHEME, new ToolchainFileSystem(sysrootFiles), { isReadonly: true });
	const code2Protocol = (uri: vscode.Uri) => uri.scheme === TOOLCHAIN_SCHEME ? `file://${uri.path}` : `file://${toGuestPath(folder.path, uri.path) ?? GUEST_WORKSPACE}`;
	const protocol2Code = (value: string) => {
		const guestPath = decodeURIComponent(value.replace(/^file:\/\//, ''));
		if (isToolchainGuestPath(guestPath)) { return vscode.Uri.from({ scheme: TOOLCHAIN_SCHEME, path: guestPath }); }
		const hostPath = fromGuestPath(folder.path, guestPath);
		return hostPath !== undefined ? folder.with({ path: hostPath }) : vscode.Uri.parse(value);
	};
	let client!: LanguageClient;
	const overlayFlags = fallbackFlags(compileFlags, extraFlags);
	const sendOverlay = async (uris: readonly vscode.Uri[]) => {
		const guestPaths = uris.flatMap(u => toGuestPath(folder.path, u.path) ?? []);
		for (const batch of batches(guestPaths, OVERLAY_BATCH_SIZE)) {
			await client.sendNotification('workspace/didChangeConfiguration', { settings: { compilationDatabaseChanges: compilationDatabaseChanges(batch, overlayFlags) } });
		}
	};
	const sourceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{c,cc,cpp,cxx}'));
	const createdSub = sourceWatcher.onDidCreate(uri => { void sendOverlay([uri]).catch(e => log.appendLine(`[vscwclang] clangd: could not register ${uri.path} for indexing: ${errorText(e)}`)); });
	const disposeWatchers = () => { createdSub.dispose(); sourceWatcher.dispose(); };
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'c' }, { language: 'cpp' }, { scheme: TOOLCHAIN_SCHEME }],
		uriConverters: { code2Protocol, protocol2Code },
		initializationOptions: { fallbackFlags: overlayFlags },
		synchronize: { fileEvents: sourceWatcher },
	};
	client = new LanguageClient('vscwclangClangd', 'vscwClang clangd', () => Promise.resolve(transports), clientOptions);
	try {
		await client.start();
	} catch (e) {
		// A process that died during startup rejects start(); stop everything started so far so nothing leaks.
		disposeWatchers();
		toolchainFs.dispose();
		void process.terminate();
		throw new Error(`clangd failed to start: ${errorText(e)}. ${stderrTail() || 'It wrote nothing to stderr.'} Did you mean to reload the window?`);
	}

	void (async () => {
		try {
			if (databaseDir !== undefined) { return; }
			await sendOverlay(await discoverWorkspaceSources());
		} catch (e) {
			log.appendLine(`[vscwclang] clangd: could not register workspace sources for background indexing: ${errorText(e)}`);
		}
	})();

	return new vscode.Disposable(() => {
		void (async () => {
			disposeWatchers();
			const stopped = client.stop().catch(e => log.appendLine(`[vscwclang] stopping clangd: ${errorText(e)}`));
			const timer = setTimeout(() => void process.terminate(), 5_000);
			try { await Promise.race([stopped, exited.catch(() => undefined)]); } finally { clearTimeout(timer); }
		})();
	});
}

/** Adapts a `WasmProcess`'s pipe stdio to the duplex-stream shape `vscode-jsonrpc`'s stream reader/writer expect. */
function makeMessageTransports(process: PipedProcess, exited: Promise<number>, log: vscode.OutputChannel): MessageTransports {
	const closeListeners = new Set<() => void>();
	void exited.then(() => { for (const l of closeListeners) { l(); } }).catch(() => { for (const l of closeListeners) { l(); } });
	const onClose = (listener: () => void) => { closeListeners.add(listener); return new vscode.Disposable(() => closeListeners.delete(listener)); };
	const noError = () => new vscode.Disposable(() => undefined);
	const reader = new ReadableStreamMessageReader({
		onData: listener => process.stdout!.onData(listener),
		onClose,
		onError: noError,
		onEnd: onClose,
	});
	const writer = new WriteableStreamMessageWriter({
		write: (chunk: Uint8Array | string) => process.stdin!.write(chunk),
		end: () => undefined,
		onClose,
		onError: noError,
		onEnd: onClose,
	});
	reader.onError(e => log.appendLine(`[vscwclang] clangd message reader error: ${errorText(e)}`));
	return { reader, writer };
}

/** Short stable id of the workspace folder, so projects with the same relative paths do not share index shards. */
async function workspaceKey(folder: vscode.Uri): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(folder.toString()));
	return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
