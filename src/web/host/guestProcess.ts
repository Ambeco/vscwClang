import { SPAWN_THREAD_OP, type DoneMessage, type StartMessage, type ThreadMessage } from './guestWorker';
import { CHANNEL_BYTES, SyncRpcServer, type RpcHandler, type RpcRequest } from './syncChannel';
import type { RpcStats } from './rpcStats';
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

function newTidCounter(): SharedArrayBuffer {
	const buffer = new SharedArrayBuffer(4);
	Atomics.store(new Int32Array(buffer), 0, 1); // 0 is the main thread
	return buffer;
}

/** A trap in one of the program's threads, as `GuestProcessOptions.onTrap` sees it. */
export interface TrapReport {
	/** 0 is the main thread, then the ids `thread-spawn` hands out. */
	tid: number;
	message: string;
	stack?: string;
	stackPointer?: number;
}

export type ProcessOutcome = GuestResult | { kind: 'terminated' } | { kind: 'failed'; message: string };

export interface GuestProcessOptions {
	module: WebAssembly.Module;
	args: string[];
	env: Record<string, string>;
	preopens: string[];
	/** See `GuestOptions.terminal`. */
	terminal?: boolean;
	fs: GuestFileSystem;
	stdin: StdinQueue;
	onOutput: (fd: 1 | 2, data: Uint8Array) => void;
	/** Counts every request from every Worker of the process (see `RpcStats`). */
	stats?: RpcStats;
	createWorker: () => WorkerLike;
	/** Makes the Worker for each `thread-spawn` (needed only with `sharedMemory`); async so callers can reuse `createGuestWorker`. */
	createThreadWorker?: () => WorkerLike | Promise<WorkerLike>;
	/** For a wasi-threads module: the shared memory it imports, from `createSharedMemory`. */
	sharedMemory?: WebAssembly.Memory;
	/**
	 * Asked when a thread traps: returning true holds the process, with every Worker alive and the shared memory
	 * intact, so a debugger can inspect it; the process then ends (as the trap, not as terminated) when `terminate()`
	 * is called. Only the first trap is held; a later one (another thread) is ignored.
	 */
	onTrap?: (trap: TrapReport) => boolean;
}

/**
 * One guest program running in its own Worker, served from the extension host.
 *
 * `run` resolves when the program exits, traps (the engine's message is in the outcome), fails to start, or
 * `terminate` is called. Because the Worker is ours, a trap or a blocked read can always be ended.
 */
export class GuestProcess {
	private worker: WorkerLike | undefined;
	private readonly threadWorkers: WorkerLike[] = [];
	private settle: ((outcome: ProcessOutcome) => void) | undefined;
	private heldTrap: ProcessOutcome | undefined;

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
				for (const thread of this.threadWorkers) { thread.terminate(); }
				resolve(outcome);
			};
			this.settle = finish;
			const channel = new SharedArrayBuffer(CHANNEL_BYTES);
			const threads = options.sharedMemory ? { memory: options.sharedMemory, tidCounter: newTidCounter() } : undefined;
			this.serve(worker, channel, finish, threads, 0);
			worker.postMessage({ type: 'start', module: options.module, args: options.args, env: options.env, preopens: options.preopens, terminal: options.terminal, channel, threads } satisfies StartMessage);
		});
	}

	/** Answers one Worker's messages: its end, its failure, a request to spawn a thread, or a file/stdio request. */
	private serve(worker: WorkerLike, channel: SharedArrayBuffer, finish: (outcome: ProcessOutcome) => void, threads: StartMessage['threads'], tid: number): void {
		const server = new SyncRpcServer(channel, this.makeHandler(), this.options.stats);
		worker.onMessage(message => {
			const done = message as DoneMessage;
			if (done.type === 'done') {
				if (done.result.kind === 'trap' && this.options.onTrap) {
					if (this.heldTrap) { return; }
					const { message: text, stack, stackPointer } = done.result;
					if (this.options.onTrap({ tid, message: text, stack, stackPointer })) { this.heldTrap = done.result; return; }
				}
				finish(done.result);
			}
			else if (done.type === 'failed') { finish({ kind: 'failed', message: done.message }); }
			else if ((message as RpcRequest).op === SPAWN_THREAD_OP) { void this.spawnThread((message as RpcRequest).args as { tid: number; startArg: number }, finish, threads); }
			else { void server.handle(message as RpcRequest); }
		});
		worker.onError(message => finish({ kind: 'failed', message }));
	}

	private async spawnThread({ tid, startArg }: { tid: number; startArg: number }, finish: (outcome: ProcessOutcome) => void, threads: StartMessage['threads']): Promise<void> {
		const { options } = this;
		try {
			if (!threads || !options.createThreadWorker) { throw new Error('the program called thread-spawn but this GuestProcess has no sharedMemory and createThreadWorker. Did you mean to pass both?'); }
			const worker = await options.createThreadWorker();
			if (!this.settle) { worker.terminate(); return; }
			this.threadWorkers.push(worker);
			const channel = new SharedArrayBuffer(CHANNEL_BYTES);
			this.serve(worker, channel, finish, threads, tid);
			worker.postMessage({ type: 'thread', module: options.module, args: options.args, env: options.env, preopens: options.preopens, terminal: options.terminal, channel, threads, tid, startArg } satisfies ThreadMessage);
		} catch (e) {
			finish({ kind: 'failed', message: `could not start thread ${tid}: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	terminate(): void {
		this.settle?.(this.heldTrap ?? { kind: 'terminated' });
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
