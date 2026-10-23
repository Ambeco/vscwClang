import { GuestFsError, type FsErrno } from './wasiGuest';

/** One side of a message port: a Web Worker (or `self` inside one) in the browser, a `worker_threads` port in node tests. */
export interface Endpoint {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onMessage(listener: (message: unknown) => void): void;
}

export interface RpcRequest {
	id: number;
	op: string;
	args: unknown;
	bytes?: Uint8Array<ArrayBuffer>;
	/** False for fire-and-forget requests (stdout), which get no response. */
	reply: boolean;
}

export interface RpcResult { value?: unknown; bytes?: Uint8Array }
export type RpcHandler = (op: string, args: unknown, bytes: Uint8Array | undefined) => Promise<RpcResult | void>;

const HEADER_BYTES = 16;
const CHUNK_BYTES = 256 * 1024;
export const CHANNEL_BYTES = HEADER_BYTES + CHUNK_BYTES;
const STATE = 0;
const LENGTH = 1;
const LAST = 2;
const FS_ERRNOS = new Set<string>(['ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EACCES', 'EIO', 'ENOSYS']);

/**
 * The Worker's side of the synchronous-over-asynchronous channel.
 *
 * A request goes to the extension host as a message, then the Worker blocks in `Atomics.wait` until the host
 * has written the whole response into the shared buffer. This is how a Worker uses `vscode.workspace.fs`, the
 * terminal and (later) Worker creation, none of which exist inside it; see documents/design.md "Host".
 *
 * One channel serves one Worker: a Worker blocks while it waits, so it never has two requests in flight.
 */
export class SyncRpcClient {
	private nextId = 1;
	private readonly state: Int32Array;
	private readonly data: Uint8Array;

	constructor(private readonly endpoint: Endpoint, shared: SharedArrayBuffer) {
		this.state = new Int32Array(shared, 0, HEADER_BYTES / 4);
		this.data = new Uint8Array(shared, HEADER_BYTES);
	}

	call(op: string, args: unknown, bytes?: Uint8Array): { value: unknown; bytes: Uint8Array } {
		this.send(op, args, bytes, true);
		const response = this.receive();
		const jsonLength = new DataView(response.buffer, response.byteOffset).getUint32(0, true);
		const parsed = JSON.parse(new TextDecoder().decode(response.subarray(4, 4 + jsonLength))) as { value?: unknown; error?: { code?: string; message: string } };
		if (parsed.error) {
			if (parsed.error.code && FS_ERRNOS.has(parsed.error.code)) { throw new GuestFsError(parsed.error.code as FsErrno, parsed.error.message); }
			throw new Error(parsed.error.message);
		}
		return { value: parsed.value, bytes: response.subarray(4 + jsonLength) };
	}

	post(op: string, args: unknown, bytes?: Uint8Array): void {
		this.send(op, args, bytes, false);
	}

	private send(op: string, args: unknown, bytes: Uint8Array | undefined, reply: boolean): void {
		const copy = bytes ? new Uint8Array(bytes) : undefined;
		const request: RpcRequest = { id: this.nextId++, op, args, bytes: copy, reply };
		this.endpoint.postMessage(request, copy ? [copy.buffer] : []);
	}

	private receive(): Uint8Array {
		const parts: Uint8Array[] = [];
		for (;;) {
			Atomics.wait(this.state, STATE, 0);
			const length = this.state[LENGTH];
			const last = this.state[LAST] === 1;
			parts.push(this.data.slice(0, length));
			Atomics.store(this.state, STATE, 0);
			Atomics.notify(this.state, STATE);
			if (last) { break; }
		}
		if (parts.length === 1) { return parts[0]; }
		const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		parts.reduce((off, p) => { whole.set(p, off); return off + p.length; }, 0);
		return whole;
	}
}

/** The extension host's side: answers each request and streams the response into the shared buffer. */
export class SyncRpcServer {
	private readonly state: Int32Array;
	private readonly data: Uint8Array;

	constructor(shared: SharedArrayBuffer, private readonly handler: RpcHandler) {
		this.state = new Int32Array(shared, 0, HEADER_BYTES / 4);
		this.data = new Uint8Array(shared, HEADER_BYTES);
	}

	async handle(request: RpcRequest): Promise<void> {
		let json: string;
		let bytes: Uint8Array | undefined;
		try {
			const result = await this.handler(request.op, request.args, request.bytes);
			json = JSON.stringify({ value: result?.value });
			bytes = result?.bytes;
		} catch (e) {
			const code = (e as { code?: unknown }).code;
			json = JSON.stringify({ error: { code: typeof code === 'string' ? code : undefined, message: e instanceof Error ? e.message : String(e) } });
		}
		if (!request.reply) { return; }
		const head = new TextEncoder().encode(json);
		const whole = new Uint8Array(4 + head.length + (bytes?.length ?? 0));
		new DataView(whole.buffer).setUint32(0, head.length, true);
		whole.set(head, 4);
		if (bytes) { whole.set(bytes, 4 + head.length); }
		await this.stream(whole);
	}

	private async stream(whole: Uint8Array): Promise<void> {
		let offset = 0;
		do {
			const length = Math.min(CHUNK_BYTES, whole.length - offset);
			this.data.set(whole.subarray(offset, offset + length));
			offset += length;
			const last = offset >= whole.length;
			this.state[LENGTH] = length;
			this.state[LAST] = last ? 1 : 0;
			Atomics.store(this.state, STATE, 1);
			Atomics.notify(this.state, STATE);
			if (!last) { await this.untilConsumed(); }
		} while (offset < whole.length);
	}

	// Firefox has no Atomics.waitAsync; polling is slow but only matters for responses over one chunk.
	private async untilConsumed(): Promise<void> {
		const wait = (Atomics as unknown as { waitAsync?: (a: Int32Array, i: number, v: number) => { async: boolean; value: Promise<string> | string } }).waitAsync;
		while (Atomics.load(this.state, STATE) === 1) {
			if (wait) {
				const result = wait(this.state, STATE, 1);
				if (result.async) { await result.value; }
			} else {
				await new Promise(resolve => setTimeout(resolve, 1));
			}
		}
	}
}
