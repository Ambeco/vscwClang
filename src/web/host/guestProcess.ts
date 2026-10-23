import type { DoneMessage, StartMessage } from './guestWorker';
import { CHANNEL_BYTES, SyncRpcServer, type RpcHandler, type RpcRequest } from './syncChannel';
import type { GuestDirEntry, GuestResult, GuestStat } from './wasiGuest';

/** What `GuestProcess` needs from a Worker; `Worker` itself in the browser, an adapter over `worker_threads` in node tests. */
export interface WorkerLike {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onMessage(listener: (message: unknown) => void): void;
	onError(listener: (message: string) => void): void;
	terminate(): void;
}

/** The files a guest sees, addressed by absolute guest path; the mount table lives behind it. Failures carry a `code` (see `FsErrno`). */
export interface GuestFileSystem {
	stat(path: string): Promise<GuestStat>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	readDirectory(path: string): Promise<GuestDirEntry[]>;
	createDirectory(path: string): Promise<void>;
	delete(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

/** Bytes typed for the guest; a read waits until some arrive or input ends. */
export class StdinQueue {
	private chunks: Uint8Array[] = [];
	private waiting: ((bytes: Uint8Array) => void) | undefined;
	private ended = false;

	push(bytes: Uint8Array): void {
		if (this.waiting) {
			const wake = this.waiting;
			this.waiting = undefined;
			wake(bytes);
		} else {
			this.chunks.push(bytes);
		}
	}

	end(): void {
		this.ended = true;
		this.waiting?.(new Uint8Array(0));
		this.waiting = undefined;
	}

	read(maxBytes: number): Promise<Uint8Array> {
		if (this.chunks.length > 0) { return Promise.resolve(this.take(maxBytes)); }
		if (this.ended) { return Promise.resolve(new Uint8Array(0)); }
		return new Promise(resolve => { this.waiting = bytes => { this.chunks.push(bytes); resolve(this.take(maxBytes)); }; });
	}

	private take(maxBytes: number): Uint8Array {
		const first = this.chunks[0];
		if (first.length <= maxBytes) { this.chunks.shift(); return first; }
		this.chunks[0] = first.subarray(maxBytes);
		return first.subarray(0, maxBytes);
	}
}

export type ProcessOutcome = GuestResult | { kind: 'terminated' } | { kind: 'failed'; message: string };

export interface GuestProcessOptions {
	module: WebAssembly.Module;
	args: string[];
	env: Record<string, string>;
	preopens: string[];
	fs: GuestFileSystem;
	stdin: StdinQueue;
	onOutput: (fd: 1 | 2, data: Uint8Array) => void;
	createWorker: () => WorkerLike;
}

/**
 * One guest program running in its own Worker, served from the extension host.
 *
 * `run` resolves when the program exits, traps (the engine's message is in the outcome), fails to start, or
 * `terminate` is called. Because the Worker is ours, a trap or a blocked read can always be ended, unlike
 * under `wasm-wasi-core`.
 */
export class GuestProcess {
	private worker: WorkerLike | undefined;
	private settle: ((outcome: ProcessOutcome) => void) | undefined;

	constructor(private readonly options: GuestProcessOptions) {}

	run(): Promise<ProcessOutcome> {
		return new Promise<ProcessOutcome>(resolve => {
			const { options } = this;
			const worker = options.createWorker();
			this.worker = worker;
			const finish = (outcome: ProcessOutcome) => {
				if (!this.settle) { return; }
				this.settle = undefined;
				worker.terminate();
				resolve(outcome);
			};
			this.settle = finish;
			const channel = new SharedArrayBuffer(CHANNEL_BYTES);
			const server = new SyncRpcServer(channel, this.makeHandler());
			worker.onMessage(message => {
				const done = message as DoneMessage;
				if (done.type === 'done') { finish(done.result); } else if (done.type === 'failed') { finish({ kind: 'failed', message: done.message }); } else { void server.handle(message as RpcRequest); }
			});
			worker.onError(message => finish({ kind: 'failed', message }));
			worker.postMessage({ type: 'start', module: options.module, args: options.args, env: options.env, preopens: options.preopens, channel } satisfies StartMessage);
		});
	}

	terminate(): void {
		this.settle?.({ kind: 'terminated' });
	}

	private makeHandler(): RpcHandler {
		const { fs, stdin, onOutput } = this.options;
		return async (op, args, bytes) => {
			const { path, from, to, fd, maxBytes } = args as { path: string; from: string; to: string; fd: 1 | 2; maxBytes: number };
			switch (op) {
				case 'stdin': return { bytes: await stdin.read(maxBytes) };
				case 'output': onOutput(fd, bytes ?? new Uint8Array(0)); return;
				case 'stat': return { value: await fs.stat(path) };
				case 'readFile': return { bytes: await fs.readFile(path) };
				case 'writeFile': await fs.writeFile(path, bytes ?? new Uint8Array(0)); return;
				case 'readDirectory': return { value: await fs.readDirectory(path) };
				case 'createDirectory': await fs.createDirectory(path); return;
				case 'delete': await fs.delete(path); return;
				case 'rename': await fs.rename(from, to); return;
				default: throw new Error(`vscwClang: the guest Worker sent an unknown request '${op}'. Did you mean one of stdin, output, stat, readFile, writeFile, readDirectory, createDirectory, delete, rename?`);
			}
		};
	}
}
