import * as vscode from 'vscode';
import { getFile, missingBytes, ProgressTracker, resolveManifest, type ByteStore, type DownloadOptions, type ToolchainManifest } from './toolchainDownload';
import { TOOLCHAIN_PIN } from './toolchainPin';

/** The part of `vscode.ExtensionContext` the toolchain cache needs. */
export type StoreContext = Pick<vscode.ExtensionContext, 'globalStorageUri'>;

/** Files `build()` needs; lldb joins when debugging lands. */
export const BUILD_FILES = ['clang.wasm', 'lld.wasm', 'sysroot.zip', 'compile-flags.json'];

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** The notifications the store raises; tests pass a recorder instead of the real window. */
export interface StoreUi {
	showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
	showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

const reported = new WeakSet<object>();

/** True for a download error the user was already told about (dialog or own cancellation), so callers need not add another popup. */
export const wasReported = (e: unknown) => typeof e === 'object' && e !== null && reported.has(e);

/** Shows a notification only if `work` is still running after `delayMs`, so a cached-manifest lookup does not flash one. */
async function withSlowProgress<T>(title: string, work: Promise<T>, delayMs = 400): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const slow = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), delayMs); });
	const isSlow = await Promise.race([work.then(() => false, () => false), slow]);
	clearTimeout(timer);
	return isSlow ? vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => work) : work;
}

const OVERRIDE_SETTING = 'toolchainUrl';

class VscodeByteStore implements ByteStore {
	constructor(private readonly root: vscode.Uri) {}
	private uri(name: string) { return vscode.Uri.joinPath(this.root, ...name.split('/')); }
	async size(name: string) {
		try { return (await vscode.workspace.fs.stat(this.uri(name))).size; } catch { return undefined; }
	}
	async read(name: string) { return await vscode.workspace.fs.readFile(this.uri(name)) as Uint8Array<ArrayBuffer>; }
	async write(name: string, bytes: Uint8Array) {
		const uri = this.uri(name);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, bytes);
	}
	async delete(name: string) {
		try { await vscode.workspace.fs.delete(this.uri(name)); } catch { /* absent */ }
	}
	async removeDirsExcept(keep: string) {
		for (const [entry, type] of await vscode.workspace.fs.readDirectory(this.root)) {
			if (type === vscode.FileType.Directory && entry !== keep) {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.root, entry), { recursive: true, useTrash: false });
			}
		}
	}
}

/**
 * Downloads the toolchain on first use, caches it in the extension's global storage, and serves verified bytes.
 *
 * The pinned manifest hash (toolchainPin.ts) fixes exactly which bytes are accepted. The application-scoped
 * setting `vscwclang.toolchainUrl` overrides the host and skips the pin (for development; a workspace cannot
 * set it). Cached versions live in `toolchain/<manifest sha16>/`; other versions are removed after a successful
 * download. Progress shows as one notification covering everything still missing; concurrent callers share it.
 */
export class ToolchainStore {
	private ready: Promise<{ manifest: ToolchainManifest; keyDir: string; store: VscodeByteStore; opts: DownloadOptions }> | undefined;
	private queue: Promise<void> | undefined;
	private pending = 0;
	private readonly downloaded = new vscode.EventEmitter<void>();
	/** Fires after every `ensure` that succeeded (including when nothing was missing). */
	readonly onDidEnsure = this.downloaded.event;

	constructor(private readonly context: StoreContext, private readonly log: vscode.OutputChannel, private readonly testing: { ui?: StoreUi; retryDelayMs?: number } = {}) {}

	private get ui(): StoreUi { return this.testing.ui ?? vscode.window; }

	/** Identifies the exact toolchain bytes (manifest hash prefix), for cache keys. */
	async version(): Promise<string> {
		return (await this.init()).keyDir;
	}

	async getFile(name: string): Promise<Uint8Array<ArrayBuffer>> {
		await this.ensure([name]);
		const { manifest, keyDir, store, opts } = await this.init();
		return getFile(manifest, store, keyDir, name, opts);
	}

	/** Downloads whatever is missing among `names` (default: everything `build()` needs), with a progress notification. */
	ensure(names: string[] = BUILD_FILES, options: { userInitiated?: boolean } = {}): Promise<void> {
		if (options.userInitiated && this.pending > 0) {
			void this.ui.showInformationMessage('vscwClang: the plugin cannot function until it has downloaded the clang tools, and that download is still in progress. This command continues when it finishes.');
		}
		this.pending++;
		const run = (this.queue ?? Promise.resolve()).then(() => this.download(names)).then(
			() => this.downloaded.fire(),
			e => { if (typeof e === 'object' && e !== null) { reported.add(e); } this.reportFailure(e, names); throw e; }).finally(() => { this.pending--; });
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** One error dialog with the real reason; not shown when the user cancelled. Retry runs `ensure` again (which reports its own failure). */
	private reportFailure(e: unknown, names: string[]) {
		const reason = e instanceof Error ? e.message : String(e);
		this.log.appendLine(`[vscwclang] toolchain download failed: ${reason}`);
		if (/was cancelled/.test(reason)) { return; }
		void this.ui.showErrorMessage(`vscwClang: the plugin cannot function until it successfully downloads the clang tools, and ${isOffline() ? 'you appear to be offline' : 'the last download attempt failed'}. ${reason} Finished files are kept, so retrying continues where it stopped.`, 'Retry', 'Show Log').then(choice => {
			if (choice === 'Retry') { this.ensure(names).catch(() => undefined); } else if (choice) { this.log.show(true); }
		});
	}

	async clear(): Promise<void> {
		this.ready = undefined;
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.context.globalStorageUri, 'toolchain'), { recursive: true, useTrash: false }).then(undefined, () => undefined);
	}

	private init() {
		this.ready ??= this.makeReady().catch(e => { this.ready = undefined; throw e; });
		return this.ready;
	}

	private async makeReady() {
		const override = vscode.workspace.getConfiguration('vscwclang').get<string>(OVERRIDE_SETTING, '').trim();
		const baseUrl = override || TOOLCHAIN_PIN.baseUrl;
		if (!override && !TOOLCHAIN_PIN.manifestSha256) {
			throw new Error('vscwClang: this build of the extension has no published toolchain pinned yet (toolchainPin.ts). Did you mean to set vscwclang.toolchainUrl to a locally served toolchain (see scripts/make-toolchain-dist.mjs)?');
		}
		const root = new VscodeByteStore(vscode.Uri.joinPath(this.context.globalStorageUri, 'toolchain'));
		const opts: DownloadOptions = { baseUrl, isOffline, retryDelayMs: this.testing.retryDelayMs };
		const { manifest, sha256 } = await resolveManifest(root, opts, override ? undefined : TOOLCHAIN_PIN.manifestSha256);
		if (override) { this.log.appendLine(`[vscwclang] toolchain override ${baseUrl}: manifest ${sha256.slice(0, 16)} accepted without a pin`); }
		return { manifest, keyDir: sha256.slice(0, 16), store: root, opts };
	}

	private async download(names: string[]): Promise<void> {
		const { manifest, keyDir, store, opts } = await withSlowProgress('vscwClang: contacting the toolchain host (the clang tools are downloaded once, on first use)...', this.init());
		const total = await missingBytes(manifest, store, keyDir, names);
		if (total === 0) { return; }
		this.log.appendLine(`[vscwclang] downloading toolchain ${manifest.tag} (${(total / 1048576).toFixed(1)} MB) from ${opts.baseUrl}`);
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `vscwClang: downloading the C++ toolchain ${manifest.tag} (one-time, ${(total / 1048576).toFixed(0)} MB; needed for Build, Run, Debug and IntelliSense)`, cancellable: true }, async (progress, token) => {
			const abort = new AbortController();
			token.onCancellationRequested(() => abort.abort());
			let reported = 0;
			const tracker = new ProgressTracker({
				onProgress: (done, all) => {
					const pct = Math.floor(done / all * 100);
					progress.report({ increment: pct - reported, message: `${(done / 1048576).toFixed(0)} / ${(all / 1048576).toFixed(0)} MB` });
					reported = pct;
				},
			}, total);
			for (const name of names) {
				await getFile(manifest, store, keyDir, name, { ...opts, signal: abort.signal }, tracker);
			}
		});
		await store.removeDirsExcept(keyDir).catch(() => undefined);
		this.log.appendLine('[vscwclang] toolchain download complete');
	}
}
