import * as vscode from 'vscode';
import { DidCloseTextDocumentNotification, DidOpenTextDocumentNotification, type DidCloseTextDocumentParams, type DidOpenTextDocumentParams } from 'vscode-languageclient/browser';
import { DEFAULT_EXCLUDED_DIRS, isExcludedSource } from '../toolchain/sourceFilter';

/** The slice of `LanguageClient` the sweep needs; narrowed so it can be constructed before the real client is. */
export interface NotificationSender {
	sendNotification(type: typeof DidOpenTextDocumentNotification.type, params: DidOpenTextDocumentParams): Promise<void>;
	sendNotification(type: typeof DidCloseTextDocumentNotification.type, params: DidCloseTextDocumentParams): Promise<void>;
}

const DEFAULT_HOLD_OPEN_MS = 300;
const DEFAULT_PAUSE_MS = 200;

export interface IndexSweepOptions {
	/** When false the loop stops before the next file (queued work is kept); `start()`/`enqueue` resume it once true again. */
	enabled?: boolean;
	/** How long to leave a file open before closing it, giving clangd time to parse and index it. */
	holdOpenMs?: number;
	/** Pause between files, so a real request (completion, hover, ...) gets a gap to go through. */
	pauseMs?: number;
}

export interface IndexProgress {
	/** Files finished (indexed, skipped, or unreadable) in the current burst of work. */
	done: number;
	/** Files queued in the current burst, finished or not; `done === total` means the sweep is idle. */
	total: number;
}

/** Which queue `enqueue` puts files in: `config` (named by tasks.json/launch.json) drains before everything else. */
export type SweepTier = 'config' | 'normal';

type Ownership = 'fake' | 'real';

/**
 * Drives clangd's indexing by sending it `textDocument/didOpen`/`didClose` for workspace files it was not
 * otherwise told about, one at a time, since the single-threaded `clangd.wasm` build has no background-index
 * worker thread (`-background-index=false`; see documents/remaining_work.md "V3 idea: clangd"). clangd keeps
 * an in-memory index of every file opened during the process's life, so opening and closing each file once is
 * enough; the loop pauses between files so a real completion/hover/diagnostics request is not stuck behind the
 * whole sweep.
 *
 * Three priority tiers, drained in this order: `configQueue` (files named by the build/launch configuration, via
 * `enqueue(uris, 'config')`; they are what the user builds and runs, so likely relevant even when not open or
 * nearby), `priorityQueue`, then the plain `queue`. Files in the same folder as a currently (really) open document jump a separate
 * `priorityQueue` ahead of the plain `queue`, since those are the files a user actively looking at one file is
 * most likely to need next (sibling source/header, go-to-definition into a neighbour, ...). A measurement
 * (documents/remaining_work.md "Chosen indexing mitigation") found that an "includes" tier is unnecessary:
 * fake-opening a `.cpp` already indexes its headers' own symbols well enough for cross-TU go-to-definition, as
 * long as some swept source includes each header.
 *
 * Race handling: a file already open in a real editor is never fake-opened (it is already indexed via the real
 * open), and `IndexSweep` must never send `didClose` for a file the user still has open. The dangerous direction
 * is the real editor opening a file the sweep currently has fake-open: left alone, both the sweep's `didOpen`
 * and the language client's own real `didOpen` would reach clangd with no `didClose` between them. `willRealOpen`
 * (wired through `LanguageClientOptions.middleware.didOpen`, which runs synchronously before the client sends
 * its own notification) closes the fake copy first, so clangd always sees a clean close-then-open instead. All
 * ownership reads/writes happen with no `await` in between, so they are atomic on the single JS thread even
 * though the surrounding sends are async.
 *
 * `onDidChangeProgress` reports done/total for the current burst of work (counters reset once the sweep goes idle),
for a status bar item. The options are re-read before every file, so a getter-backed `options` object picks up
settings changes live.

The loop (`runLoop`) exits whenever the queue is empty, rather than waiting around for more work: `enqueue`
 * and the re-queue-on-real-close path both restart it (`wake`) if it isn't already running.
 */
export class IndexSweep implements vscode.Disposable {
	private readonly configQueue: string[] = [];
	private readonly priorityQueue: string[] = [];
	private readonly queue: string[] = [];
	private readonly queued = new Set<string>();
	/** Real (host) uri for each protocol uri seen; the protocol uri alone (guest path) cannot be read from the host file system. */
	private readonly hostUris = new Map<string, vscode.Uri>();
	private readonly ownership = new Map<string, Ownership>();
	/** Directories holding at least one currently (really) open document; see "priority tiers" in the class doc. */
	private readonly realDirCounts = new Map<string, number>();
	private readonly subscriptions: vscode.Disposable[];
	private readonly progressEmitter = new vscode.EventEmitter<IndexProgress>();
	readonly onDidChangeProgress = this.progressEmitter.event;
	private done = 0;
	private total = 0;
	private disposed = false;
	private running = false;
	private loopDone: Promise<void> = Promise.resolve();

	constructor(
		private readonly client: NotificationSender,
		private readonly code2Protocol: (uri: vscode.Uri) => string,
		private readonly log: vscode.OutputChannel,
		private readonly options: IndexSweepOptions = {},
	) {
		for (const doc of vscode.workspace.textDocuments) {
			const protocolUri = code2Protocol(doc.uri);
			this.ownership.set(protocolUri, 'real');
			this.addRealDir(protocolUri);
		}
		this.subscriptions = [vscode.workspace.onDidCloseTextDocument(d => this.onRealClose(d))];
	}

	/** Must be called from `LanguageClientOptions.middleware.didOpen` before `next()`; see the class doc. */
	async willRealOpen(doc: vscode.TextDocument): Promise<void> {
		const protocolUri = this.code2Protocol(doc.uri);
		if (this.ownership.get(protocolUri) === 'fake') {
			this.ownership.delete(protocolUri);
			await this.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: protocolUri } });
		}
		this.ownership.set(protocolUri, 'real');
		this.addRealDir(protocolUri);
		this.promoteDirectory(dirOf(protocolUri));
	}

	/**
	 * Adds files to the queue, routing each into `priorityQueue` if it shares a folder with a really-open document.
	 * With tier `config`, files go to the front queue instead, and a file already queued elsewhere is moved up.
	 */
	enqueue(uris: vscode.Uri[], tier: SweepTier = 'normal'): void {
		for (const uri of uris) {
			const protocolUri = this.code2Protocol(uri);
			if (this.ownership.get(protocolUri) === 'real') { continue; }
			if (this.queued.has(protocolUri)) {
				if (tier === 'config') { this.moveToConfig(protocolUri); }
				continue;
			}
			this.queued.add(protocolUri);
			this.hostUris.set(protocolUri, uri);
			this.total++;
			this.queueFor(protocolUri, tier).push(protocolUri);
		}
		this.reportProgress();
		this.wake();
	}

	private queueFor(protocolUri: string, tier: SweepTier = 'normal'): string[] {
		if (tier === 'config') { return this.configQueue; }
		return this.realDirCounts.has(dirOf(protocolUri)) ? this.priorityQueue : this.queue;
	}

	private moveToConfig(protocolUri: string): void {
		if (this.configQueue.includes(protocolUri)) { return; }
		for (const q of [this.priorityQueue, this.queue]) {
			const i = q.indexOf(protocolUri);
			if (i >= 0) { q.splice(i, 1); }
		}
		this.configQueue.push(protocolUri);
	}

	private reportProgress(): void {
		this.progressEmitter.fire({ done: this.done, total: this.total });
		if (this.done >= this.total) { this.done = this.total = 0; }
	}

	private addRealDir(protocolUri: string): void {
		const dir = dirOf(protocolUri);
		this.realDirCounts.set(dir, (this.realDirCounts.get(dir) ?? 0) + 1);
	}

	private removeRealDir(protocolUri: string): void {
		const dir = dirOf(protocolUri);
		const count = this.realDirCounts.get(dir) ?? 0;
		if (count <= 1) { this.realDirCounts.delete(dir); } else { this.realDirCounts.set(dir, count - 1); }
	}

	/** Moves any already-queued file in `dir` from the plain queue to the priority queue, preserving order. */
	private promoteDirectory(dir: string): void {
		const matches = this.queue.filter(uri => dirOf(uri) === dir);
		if (matches.length === 0) { return; }
		this.priorityQueue.push(...matches);
		const remaining = this.queue.filter(uri => dirOf(uri) !== dir);
		this.queue.length = 0;
		this.queue.push(...remaining);
	}

	/** Starts the sweep loop; safe to call with an empty queue (e.g. before the first `enqueue`). */
	start(): void {
		this.wake();
	}

	dispose(): void {
		this.disposed = true;
		this.progressEmitter.dispose();
		for (const s of this.subscriptions) { s.dispose(); }
	}

	/** For tests: resolves once the queue drains and the loop goes idle (or the sweep is disposed). */
	async waitUntilIdle(): Promise<void> { await this.loopDone; }

	/**
	 * Restarts `runLoop` if it isn't already running. The loop exits whenever the queue is empty, so anything
	 * that can add work after that point (`enqueue`, `onRealClose`) must call this or the new work is never
	 * processed — `runLoop` has no way to be told "more may arrive later" otherwise.
	 */
	private wake(): void {
		if (this.running || this.disposed) { return; }
		this.running = true;
		this.loopDone = this.runLoop()
			.catch(e => this.log.appendLine(`[vscwclang] index sweep stopped: ${e instanceof Error ? e.message : String(e)}`))
			.finally(() => { this.running = false; });
	}

	private async runLoop(): Promise<void> {
		while (!this.disposed && this.options.enabled !== false) {
			const protocolUri = this.configQueue.shift() ?? this.priorityQueue.shift() ?? this.queue.shift();
			if (protocolUri === undefined) { return; }
			this.queued.delete(protocolUri);
			if (this.ownership.get(protocolUri) !== 'real') { await this.indexOneFile(protocolUri); }
			if (this.disposed) { return; }
			this.done++;
			this.reportProgress();
			await delay(this.options.pauseMs ?? DEFAULT_PAUSE_MS);
		}
	}

	private async indexOneFile(protocolUri: string): Promise<void> {
		const uri = this.hostUris.get(protocolUri) ?? vscode.Uri.parse(protocolUri);
		let text: string;
		try {
			text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch (e) {
			this.log.appendLine(`[vscwclang] index sweep: skipping ${protocolUri}: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (this.disposed || this.ownership.get(protocolUri) === 'real') { return; }
		this.ownership.set(protocolUri, 'fake');
		await this.client.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: { uri: protocolUri, languageId: languageIdFor(uri), version: 1, text },
		});
		await delay(this.options.holdOpenMs ?? DEFAULT_HOLD_OPEN_MS);
		// willRealOpen may have taken over this uri (and already closed this fake copy) while we were waiting.
		if (this.disposed || this.ownership.get(protocolUri) !== 'fake') { return; }
		this.ownership.delete(protocolUri);
		await this.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: protocolUri } });
	}

	private onRealClose(doc: vscode.TextDocument): void {
		const protocolUri = this.code2Protocol(doc.uri);
		if (this.ownership.get(protocolUri) === 'real') {
			this.ownership.delete(protocolUri);
			this.removeRealDir(protocolUri);
		}
		// The real close already told clangd the file is gone; queue it again so the sweep re-indexes it later.
		if (!this.queued.has(protocolUri)) {
			this.queued.add(protocolUri);
			this.hostUris.set(protocolUri, doc.uri);
			this.total++;
			this.queueFor(protocolUri).push(protocolUri);
			this.reportProgress();
		}
		this.wake();
	}
}

function languageIdFor(uri: vscode.Uri): string {
	return /\.c$/i.test(uri.path) ? 'c' : 'cpp';
}

function dirOf(protocolUri: string): string {
	return protocolUri.slice(0, protocolUri.lastIndexOf('/'));
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Finds workspace source files the same way `buildWorkspace` does (`vscwclang.sourceGlobs`/`sourceExclude`), so
 * the sweep indexes what the project actually builds rather than every stray `.cpp` under an excluded directory.
 */
export async function discoverWorkspaceSources(): Promise<vscode.Uri[]> {
	const settings = vscode.workspace.getConfiguration('vscwclang');
	const excluded = settings.get<string[]>('sourceExclude', DEFAULT_EXCLUDED_DIRS);
	const globs = settings.get<string[]>('sourceGlobs', ['**/*.{c,cc,cpp,cxx}']);
	const found = new Map<string, vscode.Uri>();
	for (const glob of globs) {
		const matches = await vscode.workspace.findFiles(glob, '**/node_modules/**');
		for (const uri of matches) { found.set(uri.toString(), uri); }
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	return [...found.values()].filter(uri => !folder || !isExcludedSource(uri.path.slice(folder.path.length), excluded));
}
