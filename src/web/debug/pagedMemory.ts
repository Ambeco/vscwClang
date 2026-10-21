/**
 * Host-independent memory access for lldb, which reads the debuggee's memory synchronously while every transport
 * (stub channel, future custom runner) fetches it asynchronously. A stop's pages are cached in `PagedMemory`;
 * `evaluateWithMemory` re-runs a lldb call after fetching whatever pages it missed.
 */

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
