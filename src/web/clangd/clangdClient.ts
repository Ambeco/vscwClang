import * as vscode from 'vscode';
import { createWorkerProcess, type PipedProcess } from '../host/workerProcess';
import { LanguageClient, ReadableStreamMessageReader, WriteableStreamMessageWriter, type LanguageClientOptions, type MessageTransports } from 'vscode-languageclient/browser';
import { loadCompileFlags, loadSysrootFiles, loadSysrootGuestFs } from '../toolchain/sysroot';
import { fallbackFlags } from './fallbackFlags';
import { getModule, getToolchainStore, markIntelliSenseSettled, whenIntelliSenseSettled } from '../toolchain/toolchain';
import { INTELLISENSE_FILES } from '../toolchain/toolchainStore';
import { chooseSlice } from '../toolchain/threadSlice';
import { GUEST_WORKSPACE, TOOLCHAIN_SCHEME, fromGuestPath, isToolchainGuestPath, toGuestPath } from '../toolchain/guestPaths';
import { ToolchainFileSystem } from '../toolchain/toolchainFileSystem';
import { clangdLogLevel, compileCommandsPath, logsClangdStderr } from '../toolchain/cppToolsSettings';
import { intelliSenseEnabled, loggingLevel, projectSettings, userFlags, workspaceRelativeGlobs } from '../projectConfig';
import { indexTargetsFromTasks } from '../toolchain/indexTargets';
import { GUEST_CACHE, GUEST_CONFIG, OVERLAY_BATCH_SIZE, SEMANTIC_TOKENS_MAX_LINES, batches, clangdArgs, clangdThreadCount, compilationDatabaseChanges, shardMountPoint } from './clangdConfig';
import { discoverTargetSources, discoverWorkspaceSources, findCompilationDatabaseDir } from './compileOverlay';
import { ClangdStatus } from './clangdStatus';
import { clangdUserConfig, headersAreCpp, mapClangdSettings } from './clangdSettings';
import { removeStaleTempFiles, type TempDirFs } from './staleTempFiles';

const CLANGD_TMP = 'clangd-tmp';
const CLANGD_CACHE = 'clangd-cache';
const CLANGD_CONFIG = 'clangd-config';
const STALE_TEMP_MS = 10 * 60_000;
const OVERLAY_DEFER_LIMIT_MS = 15_000;
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
	const startedAt = Date.now();
	const phases: string[] = [];
	const mark = (name: string) => { phases.push(`${name} ${Date.now() - startedAt}`); };

	const toolchain = getToolchainStore(context, log);
	// One download notification for what clangd needs; the rest of the toolchain follows quietly (ToolchainStore.prefetch).
	// Everything starts at once: cached files are read without queueing behind `ensure`, and a missing one downloads on its own.
	const modulePromise = getModule(toolchain, 'clangd.wasm');
	const [, { module, limits: memoryLimits }, sysrootFiles, flags, sysroot] = await Promise.all([toolchain.ensure(INTELLISENSE_FILES), modulePromise, loadSysrootFiles(toolchain), loadCompileFlags(toolchain), loadSysrootGuestFs(toolchain)]);
	mark('toolchain');
	const mappedFlags = userFlags(log, true);
	const extraFlags = mappedFlags.flags;
	// The same slice Build picks, or <thread> and <mutex> would be errors here but not there.
	const compileFlags = flags.compile[chooseSlice(Object.keys(flags.compile), vscode.workspace.getConfiguration('vscwclang').get<boolean>('threads', true), [extraFlags])].map(f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource'));
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

	// Without a database every file runs on fallback flags, so the language of `.h` and the per-language -std need a user config.
	// Files to index, each with the flags of the tasks.json build that compiles it; with no buildable task, every workspace source on fallback flags.
	const resolveSources = async () => {
		const { targets, notes } = indexTargetsFromTasks(vscode.workspace.getConfiguration('tasks', folder).get<unknown[]>('tasks'), folder.path.slice(folder.path.lastIndexOf('/') + 1), workspaceRelativeGlobs('sourceGlobs', ['**/*.{c,cc,cpp,cxx}']));
		const fromTasks = await discoverTargetSources(targets);
		return { fromTasks: fromTasks.length > 0, notes, sources: fromTasks.length > 0 ? fromTasks : (await discoverWorkspaceSources()).map(uri => ({ uri, flags: [] as string[] })) };
	};
	const initial = databaseDir === undefined ? await resolveSources() : { fromTasks: false, notes: [] as string[], sources: [] };
	initial.notes.forEach(n => log.appendLine(`[vscwclang] clangd: ${n}`));
	if (initial.fromTasks) { log.appendLine(`[vscwclang] clangd: indexing the ${initial.sources.length} file(s) that tasks.json builds, with each task's flags`); }
	const sources = initial.sources.map(s => s.uri);
	const cpptools = projectSettings('C_Cpp');
	const mapped = mapClangdSettings({
		includeHeader: cpptools.get('refactoring.includeHeader'),
		clangTidyEnabled: cpptools.get('codeAnalysis.clangTidy.enabled'),
		tidyChecksEnabled: cpptools.get('codeAnalysis.clangTidy.checks.enabled'),
		tidyChecksDisabled: cpptools.get('codeAnalysis.clangTidy.checks.disabled'),
		tidyHeaderFilter: cpptools.get('codeAnalysis.clangTidy.headerFilter'),
		tidyConfig: cpptools.get('codeAnalysis.clangTidy.config'),
		tidyFallbackConfig: cpptools.get('codeAnalysis.clangTidy.fallbackConfig'),
		tidyArgs: cpptools.get('codeAnalysis.clangTidy.args'),
	});
	mapped.notes.forEach(n => log.appendLine(`[vscwclang] ${n}`));
	const userSetsStd = extraFlags.some(f => f.startsWith('-std=') || f.startsWith('--std='));
	const useStd = databaseDir === undefined && !userSetsStd;
	const configDir = vscode.Uri.joinPath(context.globalStorageUri, CLANGD_CONFIG);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(configDir, 'clangd'));
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(configDir, 'clangd', 'config.yaml'), new TextEncoder().encode(clangdUserConfig({
		headersAsCpp: databaseDir === undefined && headersAreCpp(sources.map(u => u.path)),
		cppStd: useStd ? mappedFlags.cpp[0] : undefined,
		cStd: useStd ? mappedFlags.c[0] : undefined,
		tidyAdd: mapped.tidyAdd,
		tidyRemove: mapped.tidyRemove,
	})));

	const args = clangdArgs(clangdLogLevel(level), clangdThreadCount(globalThis.navigator?.hardwareConcurrency), mapped.args);
	mark('workspace');
	const process = await createWorkerProcess(context, {
		name: 'clangd', module, args, env: { XDG_CACHE_HOME: GUEST_CACHE, XDG_CONFIG_HOME: GUEST_CONFIG }, memoryLimits,
		mounts: [
			{ guestPath: GUEST_WORKSPACE, uri: folder },
			{ guestPath: '/sysroot', fs: sysroot.sysroot },
			{ guestPath: '/resource', fs: sysroot.resource },
			{ guestPath: '/tmp', uri: tmpDir },
			{ guestPath: GUEST_CACHE, uri: cacheDir },
			{ guestPath: GUEST_CONFIG, uri: configDir },
			...(shardMount ? [{ guestPath: shardMount, uri: cacheDir }] : []),
		],
	});
	mark('process');
	// Off the start-up path: the folder's old files are what made `createDirectory(tmpDir)` slow, and are not needed by this session.
	const tmpFs = vscode.workspace.fs;
	const tmpAccess: TempDirFs<vscode.Uri> = { readDirectory: d => tmpFs.readDirectory(d), stat: f => tmpFs.stat(f), delete: f => tmpFs.delete(f), child: (d, name) => vscode.Uri.joinPath(d, name) };
	void removeStaleTempFiles(tmpAccess, tmpDir, Date.now(), STALE_TEMP_MS).then(
		n => { if (n > 0) { log.appendLine(`[vscwclang] clangd: removed ${n} stale temporary file(s) left by earlier sessions`); } });
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
	const sendOverlay = async (entries: readonly { uri: vscode.Uri; flags: readonly string[] }[]) => {
		const perFileFlags: Record<string, readonly string[]> = {};
		for (const { uri, flags } of entries) { const guest = toGuestPath(folder.path, uri.path); if (guest !== undefined) { perFileFlags[guest] = flags; } }
		for (const batch of batches(Object.keys(perFileFlags), OVERLAY_BATCH_SIZE)) {
			await client.sendNotification('workspace/didChangeConfiguration', { settings: { compilationDatabaseChanges: compilationDatabaseChanges(batch, overlayFlags, perFileFlags) } });
		}
	};
	// A new file is indexed only if the build tasks (when there are any) would compile it.
	const registerCreated = async (uri: vscode.Uri) => {
		const { sources: current } = await resolveSources();
		const entry = current.find(s => s.uri.toString() === uri.toString());
		if (entry) { await sendOverlay([entry]); }
	};
	const sourceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{c,cc,cpp,cxx}'));
	const createdSub = sourceWatcher.onDidCreate(uri => { void registerCreated(uri).catch(e => log.appendLine(`[vscwclang] clangd: could not register ${uri.path} for indexing: ${errorText(e)}`)); });
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	const status = new ClangdStatus(statusItem);
	status.setActive(vscode.window.activeTextEditor && code2Protocol(vscode.window.activeTextEditor.document.uri));
	const editorSub = vscode.window.onDidChangeActiveTextEditor(editor => status.setActive(editor && code2Protocol(editor.document.uri)));
	const tasksSub = vscode.workspace.onDidChangeConfiguration(e => {
		if (databaseDir !== undefined || !e.affectsConfiguration('tasks', folder)) { return; }
		void resolveSources().then(r => sendOverlay(r.sources)).catch(err => log.appendLine(`[vscwclang] clangd: could not re-register sources after a tasks.json change: ${errorText(err)}`));
	});
	const disposeWatchers = () => { createdSub.dispose(); tasksSub.dispose(); sourceWatcher.dispose(); editorSub.dispose(); statusItem.dispose(); };
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'c' }, { language: 'cpp' }, { scheme: TOOLCHAIN_SCHEME }],
		uriConverters: { code2Protocol, protocol2Code },
		initializationOptions: { fallbackFlags: overlayFlags, clangdFileStatus: true },
		synchronize: { fileEvents: sourceWatcher },
		middleware: {
			// The user config's own (empty) diagnostics arrive before any source's, so they do not count.
			handleDiagnostics: (uri, diagnostics, next) => { if (!uri.path.endsWith('.yaml')) { markIntelliSenseSettled(); } next(uri, diagnostics); },
			provideDocumentSemanticTokens: (document, token, next) => document.lineCount > SEMANTIC_TOKENS_MAX_LINES ? null : next(document, token),
			provideDocumentSemanticTokensEdits: (document, resultId, token, next) => document.lineCount > SEMANTIC_TOKENS_MAX_LINES ? null : next(document, resultId, token),
		},
	};
	client = new LanguageClient('vscwclangClangd', 'vscwClang clangd', () => Promise.resolve(transports), clientOptions);
	try {
		client.onNotification('textDocument/clangd.fileStatus', (p: { uri: string; state: string }) => status.fileStatus(p.uri, p.state));
		await client.start();
		mark('initialized');
		log.appendLine(`[vscwclang] clangd start (ms): ${phases.join(', ')}`);
		status.ready();
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
			// The overlay changes the open file's compile command, which invalidates its first preamble and builds it twice; so it waits for the first diagnostics.
			await Promise.race([whenIntelliSenseSettled(), new Promise(resolve => setTimeout(resolve, OVERLAY_DEFER_LIMIT_MS))]);
			await sendOverlay(initial.sources);
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
