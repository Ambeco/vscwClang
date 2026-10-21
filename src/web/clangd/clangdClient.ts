import * as vscode from 'vscode';
import { Wasm, type WasmProcess } from '@vscode/wasm-wasi';
import { LanguageClient, ReadableStreamMessageReader, WriteableStreamMessageWriter, type LanguageClientOptions, type MessageTransports } from 'vscode-languageclient/browser';
import { loadCompileFlags, loadSysroot } from '../toolchain/sysroot';
import { fallbackFlags } from './fallbackFlags';
import { getToolchainStore } from '../toolchain/toolchain';
import { GUEST_WORKSPACE, fromGuestPath, toGuestPath } from '../toolchain/guestPaths';
import { configuredSources } from '../toolchain/projectModel';
import { clangdLogLevel, logsClangdStderr } from '../toolchain/cppToolsSettings';
import { intelliSenseEnabled, loggingLevel, readLaunches, readTasks, userFlags, variableContext } from '../projectConfig';
import { IndexSweep, discoverWorkspaceSources } from './indexSweep';

const CLANGD_ARGS = ['-sync', '-background-index=false', '-resource-dir=/resource'];
const CLANGD_TMP = 'clangd-tmp';

/**
 * Starts clangd.wasm as a long-lived `wasm-wasi-core` process and wires it to VS Code's language-client
 * machinery, so completion/hover/go-to-definition/diagnostics come from clangd instead of nothing.
 *
 * clangd.wasm is a normal toolchain-manifest entry (`llvm-artifacts/dist/manifest.json`, published at the pinned
 * tag alongside clang.wasm/lld.wasm; see the `Ambeco/llvm-artifacts` release), downloaded and cached the same way.
 * The background indexer needs a worker thread this single-threaded build doesn't have, hence
 * `-background-index=false`; `IndexSweep` (`indexSweep.ts`) works around that with a didOpen/didClose fake-
 * indexing sweep over the workspace's source files (documents/remaining_work.md "V3 idea: clangd").
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
	const wasm = await Wasm.load();
	const [bits, sysroot, flags] = await Promise.all([toolchain.getFile('clangd.wasm'), loadSysroot(wasm, toolchain), loadCompileFlags(toolchain)]);
	const compileFlags = flags.compile['wasm32-wasip1'].map(f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource'));
	const module = await WebAssembly.compile(bits);

	const tmpDir = vscode.Uri.joinPath(context.globalStorageUri, CLANGD_TMP);
	await vscode.workspace.fs.createDirectory(tmpDir);

	const process = await wasm.createProcess('clangd', module, {
		args: [...CLANGD_ARGS, `-log=${clangdLogLevel(level)}`],
		stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } },
		mountPoints: [
			{ kind: 'workspaceFolder' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.sysroot, mountPoint: '/sysroot' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.resource, mountPoint: '/resource' },
			{ kind: 'vscodeFileSystem', uri: tmpDir, mountPoint: '/tmp' },
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
	void exited.then(code => { if (code !== 0) { log.appendLine(`[vscwclang] clangd exited unexpectedly (code ${code}): ${stderrChunks.join('').slice(-800)}`); } });

	const code2Protocol = (uri: vscode.Uri) => `file://${toGuestPath(folder.path, uri.path) ?? GUEST_WORKSPACE}`;
	const protocol2Code = (value: string) => {
		const guestPath = value.replace(/^file:\/\//, '');
		const hostPath = fromGuestPath(folder.path, guestPath);
		return hostPath !== undefined ? folder.with({ path: hostPath }) : vscode.Uri.parse(value);
	};
	let client!: LanguageClient;
	const indexSweep = new IndexSweep(
		{ sendNotification: (type, params) => client.sendNotification(type, params as never) },
		code2Protocol,
		log,
		{
			get enabled() { return indexingSetting<boolean>('enabled', true); },
			get pauseMs() { return indexingSetting<number>('pauseMs', 200); },
			get holdOpenMs() { return indexingSetting<number>('holdOpenMs', 300); },
		},
	);
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	status.name = 'vscwClang indexing';
	const showProgress = (p: { done: number; total: number }) => {
		if (p.done >= p.total || !indexingSetting<boolean>('enabled', true)) { status.hide(); return; }
		status.text = `$(sync~spin) Indexing ${p.done}/${p.total}`;
		status.tooltip = 'vscwClang is indexing workspace sources so go-to-definition and symbol search work project-wide (setting: vscwclang.indexing.enabled).';
		status.show();
	};
	const progressSub = indexSweep.onDidChangeProgress(showProgress);
	const startSweep = () => {
		void (async () => {
			try {
				// Config-named files first (tier 'config'); the rest then skips them as already queued.
				const configured = await discoverConfiguredSources(folder, log);
				if (configured.length > 0) { indexSweep.enqueue(configured, 'config'); }
				indexSweep.enqueue(await discoverWorkspaceSources());
				indexSweep.start();
			} catch (e) {
				log.appendLine(`[vscwclang] index sweep: could not list workspace sources: ${e instanceof Error ? e.message : String(e)}`);
			}
		})();
	};
	const configSub = vscode.workspace.onDidChangeConfiguration(e => {
		if (!e.affectsConfiguration('vscwclang.indexing.enabled')) { return; }
		if (indexingSetting<boolean>('enabled', true)) { startSweep(); } else { status.hide(); }
	});
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'c' }, { language: 'cpp' }],
		uriConverters: { code2Protocol, protocol2Code },
		initializationOptions: { fallbackFlags: fallbackFlags(compileFlags, userFlags(log, true).flags) },
		middleware: {
			// Must run (and close any fake-indexed copy) before `next()` sends the real didOpen; see indexSweep.ts.
			didOpen: async (document, next) => { await indexSweep.willRealOpen(document); return next(document); },
		},
	};
	client = new LanguageClient('vscwclangClangd', 'vscwClang clangd', () => Promise.resolve(transports), clientOptions);
	await client.start();

	startSweep();

	return new vscode.Disposable(() => {
		void (async () => {
			indexSweep.dispose();
			progressSub.dispose();
			configSub.dispose();
			status.dispose();
			const stopped = client.stop().catch(e => log.appendLine(`[vscwclang] stopping clangd: ${e instanceof Error ? e.message : String(e)}`));
			const timer = setTimeout(() => void process.terminate(), 5_000);
			try { await Promise.race([stopped, exited]); } finally { clearTimeout(timer); }
		})();
	});
}

/** Adapts a `WasmProcess`'s pipe stdio to the duplex-stream shape `vscode-jsonrpc`'s stream reader/writer expect. */
function makeMessageTransports(process: WasmProcess, exited: Promise<number>, log: vscode.OutputChannel): MessageTransports {
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
		write: (chunk: Uint8Array | string) => process.stdin!.write(chunk as Uint8Array),
		end: () => undefined,
		onClose,
		onError: noError,
		onEnd: onClose,
	});
	reader.onError(e => log.appendLine(`[vscwclang] clangd message reader error: ${e instanceof Error ? e.message : String(e)}`));
	return { reader, writer };
}

function indexingSetting<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration('vscwclang.indexing').get<T>(key, fallback);
}

/** Workspace files that `tasks.json`/`launch.json` name as build sources, resolved from their paths/globs. */
async function discoverConfiguredSources(folder: vscode.Uri, log: vscode.OutputChannel): Promise<vscode.Uri[]> {
	try {
		const sources = configuredSources(readTasks(folder), readLaunches(folder), variableContext(folder));
		const found = new Map<string, vscode.Uri>();
		for (const source of sources) {
			for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, source), '**/node_modules/**')) { found.set(uri.toString(), uri); }
		}
		return [...found.values()];
	} catch (e) {
		log.appendLine(`[vscwclang] index sweep: ignoring tasks.json/launch.json hints: ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}
}
