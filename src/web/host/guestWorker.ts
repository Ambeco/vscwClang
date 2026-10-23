import { GuestWasi, type GuestDirEntry, type GuestResult, type GuestServices, type GuestStat } from './wasiGuest';
import { SyncRpcClient, type Endpoint } from './syncChannel';

/** What the extension host sends to start a guest. */
export interface StartMessage {
	type: 'start';
	module: WebAssembly.Module;
	args: string[];
	env: Record<string, string>;
	preopens: string[];
	channel: SharedArrayBuffer;
}

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

/** The Worker's whole job: wait for a `start` message, run the guest to its end, report how it ended. */
export function runGuestWorker(endpoint: Endpoint): void {
	endpoint.onMessage(message => {
		const start = message as StartMessage;
		if (start.type !== 'start') { return; }
		try {
			const client = new SyncRpcClient(endpoint, start.channel);
			const guest = new GuestWasi({ args: start.args, env: start.env, preopens: start.preopens, services: new RpcGuestServices(client) });
			const instance = new WebAssembly.Instance(start.module, { wasi_snapshot_preview1: guest.imports });
			const result = guest.start(instance);
			endpoint.postMessage({ type: 'done', result } satisfies DoneMessage);
		} catch (e) {
			endpoint.postMessage({ type: 'failed', message: e instanceof Error ? e.message : String(e) } satisfies DoneMessage);
		}
	});
}
