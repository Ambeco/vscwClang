import { GuestWasi, type GuestDirEntry, type GuestResult, type GuestServices, type GuestStat } from './wasiGuest';
import { SyncRpcClient, type Endpoint } from './syncChannel';

/** What the extension host sends to start a guest. */
export interface StartMessage {
	type: 'start';
	module: WebAssembly.Module;
	args: string[];
	env: Record<string, string>;
	preopens: string[];
	terminal?: boolean;
	channel: SharedArrayBuffer;
	/** For a wasi-threads module: its shared memory and the counter `thread-spawn` takes thread ids from (starts at 1). */
	threads?: { memory: WebAssembly.Memory; tidCounter: SharedArrayBuffer };
}

/** What the extension host sends to a Worker it created for a `thread-spawn` request. */
export interface ThreadMessage extends Omit<StartMessage, 'type' | 'threads'> {
	type: 'thread';
	tid: number;
	startArg: number;
	threads: NonNullable<StartMessage['threads']>;
}

/** The op a Worker (main or thread) posts to ask the extension host for a new thread Worker. */
export const SPAWN_THREAD_OP = 'spawnThread';

/** What the Worker sends back, once. */
export type DoneMessage = { type: 'done'; result: GuestResult } | { type: 'failed'; message: string };

/** `GuestServices` that forward every call to the extension host over the blocking channel. */
export class RpcGuestServices implements GuestServices {
	private readonly sleeper = new Int32Array(new SharedArrayBuffer(4));

	constructor(private readonly client: SyncRpcClient) {}

	readStdin(maxBytes: number): Uint8Array { return this.client.call('stdin', { maxBytes }).bytes; }
	writeOutput(fd: 1 | 2, data: Uint8Array): void { this.client.post('output', { fd }, data); }
	stat(path: string): GuestStat { return this.client.call('stat', { path }).value as GuestStat; }
	readFile(path: string): Uint8Array { return this.client.call('readFile', { path }).bytes; }
	writeFile(path: string, data: Uint8Array): void { this.client.call('writeFile', { path }, data); }
	readDirectory(path: string): GuestDirEntry[] { return this.client.call('readDirectory', { path }).value as GuestDirEntry[]; }
	createDirectory(path: string): void { this.client.call('createDirectory', { path }); }
	delete(path: string): void { this.client.call('delete', { path }); }
	rename(from: string, to: string): void { this.client.call('rename', { from, to }); }
	sleep(ms: number): void { Atomics.wait(this.sleeper, 0, 0, ms); }
}

/** Instantiates `message.module` against a new guest; a wasi-threads module also gets its shared memory and `thread-spawn`. */
function instantiate(endpoint: Endpoint, message: StartMessage | ThreadMessage): { guest: GuestWasi; instance: WebAssembly.Instance } {
	const client = new SyncRpcClient(endpoint, message.channel);
	const { threads } = message;
	const guest = new GuestWasi({ args: message.args, env: message.env, preopens: message.preopens, terminal: message.terminal, services: new RpcGuestServices(client), memory: threads?.memory });
	const imports: WebAssembly.Imports = { wasi_snapshot_preview1: guest.imports };
	const importsMemory = WebAssembly.Module.imports(message.module).some(i => i.module === 'env' && i.name === 'memory');
	if (importsMemory && !threads) {
		throw new Error('vscwClang: the module imports its memory (it was linked with -pthread, for wasi-threads) but the host gave it none. Did you mean to pass `sharedMemory` (see createSharedMemory) to GuestProcess?');
	}
	if (threads) {
		const counter = new Int32Array(threads.tidCounter);
		imports.env = { memory: threads.memory };
		// The extension host creates the Worker (a Worker that blocks never sees a child it created itself start), so this only asks and returns.
		imports.wasi = {
			'thread-spawn': (startArg: number) => {
				const tid = Atomics.add(counter, 0, 1);
				client.post(SPAWN_THREAD_OP, { tid, startArg });
				return tid;
			},
		};
	}
	return { guest, instance: new WebAssembly.Instance(message.module, imports) };
}

/**
 * The Worker's whole job: wait for a `start` (or, in a thread Worker, `thread`) message, run the guest to its end, report how it ended.
 *
 * A thread reports only when it ends the process (`proc_exit` or a trap); returning normally ends just that thread.
 * Each thread has its own `GuestWasi`, hence its own descriptor table: file I/O belongs on one thread (the toolchain's
 * `-pthread` programs funnel it there, see the llvm-project fork's threaded-file-io-rpc-plan.md), while stdout and stderr work from any.
 */
export function runGuestWorker(endpoint: Endpoint): void {
	endpoint.onMessage(message => {
		const request = message as StartMessage | ThreadMessage;
		if (request.type !== 'start' && request.type !== 'thread') { return; }
		try {
			const { guest, instance } = instantiate(endpoint, request);
			if (request.type === 'thread') {
				const result = guest.runThread(instance, request.tid, request.startArg);
				if (result) { endpoint.postMessage({ type: 'done', result } satisfies DoneMessage); }
			} else {
				endpoint.postMessage({ type: 'done', result: guest.start(instance) } satisfies DoneMessage);
			}
		} catch (e) {
			endpoint.postMessage({ type: 'failed', message: e instanceof Error ? e.message : String(e) } satisfies DoneMessage);
		}
	});
}
