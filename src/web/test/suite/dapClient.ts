import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DapMessage { type: string; event?: string; command?: string; request_seq?: number; success?: boolean; body?: any; message?: string }

/** Plays the DAP client in tests: sends requests, awaits their responses, records and awaits events. */
export class DapClient {
	readonly messages: DapMessage[] = [];
	private nextSeq = 1;
	private consumed = 0;
	private waiters: (() => void)[] = [];

	constructor(private readonly deliver: (request: object) => void, private readonly timeoutMs = 60_000) {}

	/** Feed every message the adapter sends here. */
	receive(message: DapMessage): void {
		this.messages.push(message);
		this.waiters.splice(0).forEach(w => w());
	}

	async request(command: string, args: object = {}): Promise<DapMessage> {
		const seq = this.nextSeq++;
		this.deliver({ seq, type: 'request', command, arguments: args });
		return this.until(() => this.messages.find(m => m.type === 'response' && m.request_seq === seq), `a response to ${command}`);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async ok(command: string, args: object = {}): Promise<any> {
		const r = await this.request(command, args);
		assert.ok(r.success, `${command} failed: ${r.message}`);
		return r.body;
	}

	/** The next `event` of this name after the ones earlier `event()` calls consumed. */
	async event(name: string): Promise<DapMessage> {
		return this.until(() => {
			const i = this.messages.findIndex((m, idx) => idx >= this.consumed && m.type === 'event' && m.event === name);
			return i >= 0 ? (this.consumed = i + 1, this.messages[i]) : undefined;
		}, `a '${name}' event`);
	}

	events(name: string): DapMessage[] { return this.messages.filter(m => m.type === 'event' && m.event === name); }

	private until<T>(find: () => T | undefined, what: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; messages so far: ${JSON.stringify(this.messages.map(m => ({ [m.event ?? m.command ?? m.type]: m.body ?? m.message })))}`)), this.timeoutMs);
			const check = () => {
				const v = find();
				if (v !== undefined) { clearTimeout(timer); resolve(v); } else { this.waiters.push(check); }
			};
			check();
		});
	}
}
