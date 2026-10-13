/**
 * Host side of the control channel to the in-process debug stub (`debugStub.c`); vscode-free, so node tests can use it.
 *
 * The stub pauses the program inside the coverage hook and talks over the program's own stdio: messages to the
 * host are `ESC _ vscw <text> ESC \` frames mixed into stderr, commands from the host are text lines on stdin. Only
 * stderr needs demultiplexing (`FrameDemux`); the host must write to stdin only while the program is stopped, so
 * commands and the program's own input never interleave. Breakpoints and "pause" therefore take effect at stops:
 * a breakpoint cannot be added to a program that is running free.
 *
 * lldb reads the debuggee's memory synchronously but the channel is asynchronous, so `PagedMemory` serves reads from
 * a per-stop page cache and records misses; `evaluateWithMemory` re-runs a lldb call after fetching what it missed.
 * Guard addresses identify breakpoints and frames: `scanProgram` maps them to DWARF pcs.
 */

const FRAME_START = new TextEncoder().encode('\x1b_vscw ');
const FRAME_END = [0x1b, 0x5c];
const decoder = new TextDecoder();

export interface StubFrame { guard: number; sp: number }

export type StubMessage =
	| { kind: 'hello'; guardStart: number; guardEnd: number }
	| { kind: 'stop'; reason: string; frames: StubFrame[] }
	| { kind: 'mem'; addr: number; data: Uint8Array }
	| { kind: 'memerr'; addr: number; len: number }
	| { kind: 'error'; text: string };

export function parseMessage(text: string): StubMessage {
	const [kind, ...rest] = text.split(' ');
	const nums = (parts: string[]) => parts.map(Number);
	switch (kind) {
		case 'hello': { const [guardStart, guardEnd] = nums(rest); return { kind, guardStart, guardEnd }; }
		case 'stop': {
			const [reason, depth, ...pairs] = rest;
			const frames: StubFrame[] = [];
			for (let i = 0; i < Number(depth); i++) { frames.push({ guard: Number(pairs[2 * i]), sp: Number(pairs[2 * i + 1]) }); }
			return { kind, reason, frames };
		}
		case 'mem': {
			const hex = rest[1] ?? '';
			const data = new Uint8Array(hex.length / 2);
			for (let i = 0; i < data.length; i++) { data[i] = parseInt(hex.substr(2 * i, 2), 16); }
			return { kind, addr: Number(rest[0]), data };
		}
		case 'memerr': return { kind, addr: Number(rest[0]), len: Number(rest[1]) };
		case 'error': return { kind, text: rest.join(' ') };
	}
	throw new Error(`vscwClang: the debug stub sent a message of unknown kind "${kind}" (${text.slice(0, 80)}); did the stub and extension versions drift apart?`);
}

export const stubCommands = {
	breakpoints: (guardAddrs: number[]) => `vscw bp ${guardAddrs.join(' ')}\n`,
	mem: (addr: number, len: number) => `vscw mem ${addr} ${len}\n`,
	go: () => 'vscw go\n',
	into: () => 'vscw into\n',
	over: () => 'vscw over\n',
	out: () => 'vscw out\n',
};

function indexOfSeq(hay: Uint8Array, needle: ArrayLike<number>, from: number): number {
	outer: for (let i = from; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) { if (hay[i + j] !== needle[j]) { continue outer; } }
		return i;
	}
	return -1;
}

/** Length of the longest suffix of `data` that is a proper prefix of `FRAME_START`. */
function partialStartLength(data: Uint8Array): number {
	for (let n = Math.min(FRAME_START.length - 1, data.length); n > 0; n--) {
		let ok = true;
		for (let j = 0; j < n && ok; j++) { ok = data[data.length - n + j] === FRAME_START[j]; }
		if (ok) { return n; }
	}
	return 0;
}

/**
 * Splits a stderr byte stream into stub messages and the program's own stderr bytes, however chunks fall.
 * `end()` flushes a held-back partial marker as program output.
 */
export class FrameDemux {
	private pending = new Uint8Array(0);
	private inFrame = false;

	constructor(private readonly onMessage: (m: StubMessage) => void, private readonly onProgramBytes: (b: Uint8Array) => void) {}

	push(chunk: Uint8Array): void {
		const merged = new Uint8Array(this.pending.length + chunk.length);
		merged.set(this.pending); merged.set(chunk, this.pending.length);
		let pos = 0;
		for (;;) {
			if (!this.inFrame) {
				const start = indexOfSeq(merged, FRAME_START, pos);
				if (start < 0) {
					const keep = partialStartLength(merged.subarray(pos));
					if (merged.length - keep > pos) { this.onProgramBytes(merged.slice(pos, merged.length - keep)); }
					this.pending = merged.slice(merged.length - keep);
					return;
				}
				if (start > pos) { this.onProgramBytes(merged.slice(pos, start)); }
				pos = start + FRAME_START.length;
				this.inFrame = true;
			}
			const end = indexOfSeq(merged, FRAME_END, pos);
			if (end < 0) { this.pending = merged.slice(pos); return; }
			this.inFrame = false;
			this.onMessage(parseMessage(decoder.decode(merged.subarray(pos, end))));
			pos = end + FRAME_END.length;
		}
	}

	end(): void {
		if (!this.inFrame && this.pending.length) { this.onProgramBytes(this.pending); }
		this.pending = new Uint8Array(0);
		this.inFrame = false;
	}
}

export const PAGE_SIZE = 4096;

/**
 * Page cache for one stop. `read` never fails: a missing page is recorded in `misses` and the read returns nothing
 * (lldb reports an error that `evaluateWithMemory` discards). A page the stub could not read is cached as
 * unreadable so retries terminate.
 */
export class PagedMemory {
	private readonly pages = new Map<number, Uint8Array | null>();
	readonly misses = new Set<number>();

	read = (addr: number, size: number): Uint8Array => {
		const first = Math.floor(addr / PAGE_SIZE), last = Math.floor((addr + Math.max(size, 1) - 1) / PAGE_SIZE);
		const out = new Uint8Array(size);
		let missing = false;
		for (let page = first; page <= last; page++) {
			const data = this.pages.get(page);
			if (data === undefined) { this.misses.add(page); missing = true; continue; }
			if (data === null) { return new Uint8Array(0); }
			const from = Math.max(addr, page * PAGE_SIZE), to = Math.min(addr + size, (page + 1) * PAGE_SIZE);
			out.set(data.subarray(from - page * PAGE_SIZE, to - page * PAGE_SIZE), from - addr);
		}
		return missing ? new Uint8Array(0) : out;
	};

	has(page: number): boolean { return this.pages.has(page); }
	set(page: number, data: Uint8Array | null): void { this.pages.set(page, data); }
	clear(): void { this.pages.clear(); this.misses.clear(); }
}

/**
 * Runs a synchronous lldb call, fetching the pages it missed and re-running it until it reads only cached memory.
 *
 * lldb does not throw on a failed read: it formats `<read memory ... failed>` into the value, and keeps that result
 * for the rest of the stop, so a plain re-run repeats it. `reset` must therefore start a fresh stop before each
 * re-run (`ReactorHost.setStop` with the same frames).
 */
export async function evaluateWithMemory<T>(memory: PagedMemory, fetchPages: (pages: number[]) => Promise<void>, op: () => T, reset: () => void = () => undefined, maxRounds = 16): Promise<T> {
	for (let round = 0; ; round++) {
		if (round > 0) { reset(); }
		memory.misses.clear();
		let result: T | undefined, error: unknown;
		try { result = op(); } catch (e) { error = e; }
		if (memory.misses.size === 0) {
			if (error !== undefined) { throw error; }
			return result as T;
		}
		if (round >= maxRounds) { throw new Error(`vscwClang: reading the debuggee's memory still missed pages after ${maxRounds} fetch rounds; did you mean to expand a smaller value?`); }
		await fetchPages([...memory.misses]);
	}
}

export interface StopEvent { reason: string; frames: StubFrame[] }

/**
 * One debug session over a transport: feed stderr bytes to `onStderr`, and the stub's commands go out through `send`.
 *
 * `nextStop()` resolves with the next `hello` (reported as reason "start") or stop. Memory is fetched on demand with
 * `readMemory`; `memory` caches pages until the next resume. Calls are not reentrant: issue one at a time.
 */
export class StubSession {
	readonly memory = new PagedMemory();
	private readonly demux: FrameDemux;
	private readonly inbox: StubMessage[] = [];
	private waiter: (() => void) | undefined;
	guardRange: { start: number; end: number } | undefined;

	constructor(private readonly send: (text: string) => void | Promise<void>, onProgramStderr: (b: Uint8Array) => void) {
		this.demux = new FrameDemux(m => { this.inbox.push(m); this.waiter?.(); }, onProgramStderr);
	}

	onStderr(chunk: Uint8Array): void { this.demux.push(chunk); }
	endStderr(): void { this.demux.end(); }

	private async take(match: (m: StubMessage) => boolean, what: string, timeoutMs: number): Promise<StubMessage> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const i = this.inbox.findIndex(match);
			if (i >= 0) { return this.inbox.splice(i, 1)[0]; }
			const err = this.inbox.findIndex(m => m.kind === 'error');
			if (err >= 0 && !match(this.inbox[err])) { const m = this.inbox.splice(err, 1)[0] as { text: string }; throw new Error(`vscwClang: the debug stub reported an error while waiting for ${what}: ${m.text}`); }
			const left = deadline - Date.now();
			if (left <= 0) { throw new Error(`vscwClang: timed out after ${timeoutMs} ms waiting for ${what} from the debug stub; did the program exit, or is it waiting for input?`); }
			await new Promise<void>(resolve => { const t = setTimeout(resolve, left); this.waiter = () => { clearTimeout(t); resolve(); }; });
			this.waiter = undefined;
		}
	}

	async nextStop(timeoutMs = 30_000): Promise<StopEvent> {
		const m = await this.take(x => x.kind === 'hello' || x.kind === 'stop', 'a stop', timeoutMs);
		this.memory.clear();
		if (m.kind === 'hello') { this.guardRange = { start: m.guardStart, end: m.guardEnd }; return { reason: 'start', frames: [] }; }
		return { reason: (m as { reason: string }).reason, frames: (m as { frames: StubFrame[] }).frames };
	}

	async setBreakpoints(guardAddrs: number[]): Promise<void> { await this.send(stubCommands.breakpoints(guardAddrs)); }
	async resume(how: 'go' | 'into' | 'over' | 'out'): Promise<void> { await this.send(stubCommands[how]()); }

	/** Fetches whole pages into the cache. */
	async fetchPages(pages: number[], timeoutMs = 30_000): Promise<void> {
		for (const page of pages) {
			if (this.memory.has(page)) { continue; }
			await this.send(stubCommands.mem(page * PAGE_SIZE, PAGE_SIZE));
			const m = await this.take(x => (x.kind === 'mem' || x.kind === 'memerr') && x.addr === page * PAGE_SIZE, `memory page 0x${(page * PAGE_SIZE).toString(16)}`, timeoutMs);
			this.memory.set(page, m.kind === 'mem' ? m.data : null);
		}
	}

	/** Runs a synchronous lldb call over this stop's memory. */
	evaluate<T>(op: () => T, reset?: () => void): Promise<T> { return evaluateWithMemory(this.memory, pages => this.fetchPages(pages), op, reset); }
}
