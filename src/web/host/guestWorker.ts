import { GuestFsError, GuestWasi, type GuestDirEntry, type GuestResult, type GuestServices, type GuestStat } from './wasiGuest';
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

/**
 * What the extension host sends to a Worker it created for a `thread-spawn` request.
 *
 * Without a `channel` the thread has no extension host to serve it (a thread of the in-process lldb reactor, made by a
 * thread-spawner Worker): it sees only `files`, any other file or stdio call fails, and it cannot spawn threads of its own.
 */
export interface ThreadMessage extends Omit<StartMessage, 'type' | 'threads' | 'channel'> {
	type: 'thread';
	channel?: SharedArrayBuffer;
	/** Read-only files this channel-less thread can see (path -> bytes), under `preopens`. */
	files?: Record<string, SharedArrayBuffer>;
	tid: number;
	startArg: number;
	threads: NonNullable<StartMessage['threads']>;
}

/** The op a Worker (main or thread) posts to ask the extension host for a new thread Worker. */
export const SPAWN_THREAD_OP = 'spawnThread';

/** Turns a Worker into a thread spawner; each `spawnThread` it then receives starts a channel-less thread Worker (see `ThreadMessage`). */
export interface SpawnerMessage {
	type: 'thread-spawner';
}

/** Sent to a thread-spawner Worker. */
export interface SpawnThreadMessage {
	type: 'spawnThread';
	module: WebAssembly.Module;
	tid: number;
	startArg: number;
	threads: NonNullable<StartMessage['threads']>;
	preopens?: string[];
	files?: Record<string, SharedArrayBuffer>;
}

/** A Worker a thread spawner starts; only `postMessage` is needed. */
export interface ChildWorker { postMessage(message: unknown): void; onMessage(listener: (message: unknown) => void): void }

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

/** Services for a thread with no extension host: it reads the shared `files`, output is dropped, anything else fails loudly. */
class NoHostServices implements GuestServices {
	constructor(private readonly files: Record<string, SharedArrayBuffer> = {}) {}

	private fail(what: string): never {
		throw new Error(`vscwClang: a thread of an in-process module called ${what}, but it has no extension host to serve it. Did you mean to do file I/O on the main thread?`);
	}
	readStdin(): Uint8Array { return this.fail('read stdin'); }
	writeOutput(): void { /* dropped */ }
	stat(path: string): GuestStat {
		const file = this.files[path];
		if (file) { return { type: 'file', size: file.byteLength, mtimeMs: 0 }; }
		if (Object.keys(this.files).some(f => f.startsWith(`${path.replace(/\/$/, '')}/`))) { return { type: 'dir', size: 0, mtimeMs: 0 }; }
		throw new GuestFsError('ENOENT', `no such file ${path}`);
	}
	readFile(path: string): Uint8Array {
		const file = this.files[path];
		if (!file) { throw new GuestFsError('ENOENT', `no such file ${path}`); }
		return new Uint8Array(file).slice();
	}
	writeFile(path: string): void { this.fail(`write ${path}`); }
	readDirectory(path: string): GuestDirEntry[] { return this.fail(`readdir ${path}`); }
	createDirectory(path: string): void { this.fail(`mkdir ${path}`); }
	delete(path: string): void { this.fail(`delete ${path}`); }
	rename(from: string): void { this.fail(`rename ${from}`); }
	sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
}

/** Instantiates `message.module` against a new guest; a wasi-threads module also gets its shared memory and `thread-spawn`. */
function instantiate(endpoint: Endpoint, message: StartMessage | ThreadMessage): { guest: GuestWasi; instance: WebAssembly.Instance } {
	const client = message.channel ? new SyncRpcClient(endpoint, message.channel) : undefined;
	const { threads } = message;
	const guest = new GuestWasi({ args: message.args, env: message.env, preopens: message.preopens, terminal: message.terminal, services: client ? new RpcGuestServices(client) : new NoHostServices('files' in message ? message.files : undefined), memory: threads?.memory });
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
				if (!client) { throw new Error('vscwClang: a thread of an in-process module tried to spawn a thread; only its main thread can.'); }
				const tid = Atomics.add(counter, 0, 1);
				client.post(SPAWN_THREAD_OP, { tid, startArg });
				return tid;
			},
		};
	}
	// A module with host imports of its own (the lldb reactor's wasm_dbg) can run threads that never call them.
	const provided = new Set(Object.keys(imports));
	for (const i of WebAssembly.Module.imports(message.module)) {
		if (i.kind !== 'function' || provided.has(i.module)) { continue; }
		(imports[i.module] ??= {})[i.name] = () => { throw new Error(`vscwClang: a thread called the host import ${i.module}.${i.name}, which only the main thread has.`); };
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
export function runGuestWorker(endpoint: Endpoint, createChild?: () => ChildWorker): void {
	let spawner = false;
	endpoint.onMessage(message => {
		const request = message as StartMessage | ThreadMessage | SpawnerMessage | SpawnThreadMessage;
		if (request.type === 'thread-spawner') { spawner = true; return; }
		if (request.type === 'spawnThread') {
			if (!spawner || !createChild) { endpoint.postMessage({ type: 'failed', message: 'vscwClang: this Worker was not started as a thread spawner. Did you mean to send thread-spawner first?' } satisfies DoneMessage); return; }
			const child = createChild();
			child.onMessage(reply => endpoint.postMessage(reply));
			child.postMessage({ type: 'thread', module: request.module, args: [], env: {}, preopens: request.preopens ?? [], files: request.files, threads: request.threads, tid: request.tid, startArg: request.startArg } satisfies ThreadMessage);
			return;
		}
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
