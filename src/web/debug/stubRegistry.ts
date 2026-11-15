import type { StubFrame } from './stubChannel';

/**
 * Reads the debug stub's thread registry (`debugStub.c`, `registry`) out of the program's shared memory; vscode-free.
 *
 * Layout: a count word, then per thread five words `id, tid, frames, depth, state`, where `frames` and `depth` are the
 * addresses of that thread's shadow stack and its length (guard, sp word pairs, outermost first). Only a thread that
 * is parked (every thread, once a stop has settled) has a stable stack; a running one's is skipped.
 */

export type StubThreadState = 'running' | 'parked';

export interface StubThread {
	/** The id the stub puts in `stop` frames; 1 is the main thread. */
	id: number;
	state: StubThreadState;
	/** Innermost first; empty for a running thread. */
	frames: StubFrame[];
}

const WORDS_PER_THREAD = 5;
// States: 1 running, 2 parked in a hook, 3 dead, 4 queued for its own stop; a queued thread has stopped too.
const STATE_RUNNING = 1;
const STATE_PARKED = 2;
const STATE_QUEUED = 4;

/** `framesOfRunning` also reads the stack of a thread that never parked: right after a trap, the trapped thread is the one still marked running. */
export function readStubThreads(buffer: ArrayBufferLike, registry: { address: number; maxThreads: number }, options: { framesOfRunning?: boolean } = {}): StubThread[] {
	const words = new Uint32Array(buffer);
	if (registry.address % 4 !== 0 || (registry.address >>> 2) + 1 + registry.maxThreads * WORDS_PER_THREAD > words.length) {
		throw new Error(`vscwClang: the debug stub's thread registry at ${registry.address} does not fit the program's memory; did the program and debug stub drift apart?`);
	}
	const count = Math.min(Atomics.load(words, registry.address >>> 2), registry.maxThreads);
	const threads: StubThread[] = [];
	for (let i = 0; i < count; i++) {
		const at = (registry.address >>> 2) + 1 + i * WORDS_PER_THREAD;
		const [id, , framesAddr, depthAddr, state] = [0, 1, 2, 3, 4].map(k => Atomics.load(words, at + k));
		if (state !== STATE_RUNNING && state !== STATE_PARKED && state !== STATE_QUEUED) { continue; }
		if (state === STATE_RUNNING && !options.framesOfRunning) { threads.push({ id, state: 'running', frames: [] }); continue; }
		const depth = Atomics.load(words, depthAddr >>> 2);
		const frames: StubFrame[] = [];
		for (let d = depth; d-- > 0;) {
			frames.push({ guard: Atomics.load(words, (framesAddr >>> 2) + 2 * d), sp: Atomics.load(words, (framesAddr >>> 2) + 2 * d + 1) });
		}
		threads.push({ id, state: state === STATE_RUNNING ? 'running' : 'parked', frames });
	}
	return threads.sort((a, b) => a.id - b.id);
}
