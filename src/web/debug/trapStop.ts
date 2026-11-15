import type { DebuggeeFrame } from './debuggeeSession';
import type { StubThread } from './stubRegistry';
import { wasmFramesFromStack } from './wasmScan';

/**
 * Turns a trap (what `GuestProcess.onTrap` reports) into the stopped state a debugger shows; vscode-free.
 *
 * The trapped thread never reaches the stub, so the host finds its shadow stack in the registry itself
 * (`pickTrappedThread`) and takes the exact pcs from the engine's stack trace (`refineFrames`).
 */

export interface TrapInput {
	/** 0 is the main thread. */
	tid: number;
	/** The trapped instance's `__stack_pointer`, when the program exports it. */
	stackPointer?: number;
}

const MAIN_THREAD_ID = 1;

/**
 * Finds which registered thread trapped, or undefined when it cannot tell.
 *
 * The main thread is told by its tid. Another thread is told by its stack pointer: stacks are disjoint, so it is the
 * thread whose outermost recorded `sp` is the lowest one at or above the trapped `sp`. Without an exported stack
 * pointer the only thread (other than main, which is often blocked in `join`) still marked running is the one.
 * `threads` must carry frames for running threads too (`readStubThreads` with `framesOfRunning`).
 */
export function pickTrappedThread(threads: StubThread[], trap: TrapInput): StubThread | undefined {
	if (trap.tid === 0) { return threads.find(t => t.id === MAIN_THREAD_ID); }
	const others = threads.filter(t => t.id !== MAIN_THREAD_ID);
	if (trap.stackPointer !== undefined) {
		let best: StubThread | undefined;
		let bestSp = Infinity;
		for (const t of others) {
			const outermost = t.frames[t.frames.length - 1]?.sp;
			if (outermost !== undefined && outermost >= trap.stackPointer && outermost < bestSp) { best = t; bestSp = outermost; }
		}
		if (best) { return best; }
	}
	const running = others.filter(t => t.state === 'running');
	return running.length === 1 ? running[0] : undefined;
}

/**
 * Replaces each shadow frame's pc with the engine's for the same function, so the top frame is the trapping
 * instruction and outer frames are call sites. Frames the trace does not mention (uninstrumented `std` code sits in
 * between) keep the pc of their last guard.
 */
export function refineFrames(shadow: DebuggeeFrame[], stack: string | undefined, codeStart: number | undefined): DebuggeeFrame[] {
	if (!stack || codeStart === undefined) { return shadow; }
	const trace = wasmFramesFromStack(stack, codeStart);
	let cursor = 0;
	return shadow.map(frame => {
		const at = trace.findIndex((t, i) => i >= cursor && t.funcIndex === frame.funcIndex);
		if (at < 0) { return frame; }
		cursor = at + 1;
		return { ...frame, pc: trace[at].pc };
	});
}
