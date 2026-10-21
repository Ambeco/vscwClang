/**
 * What the DAP controller (`debugController.ts`) needs from a running debuggee, whatever hosts it; vscode-free.
 *
 * Two hosts are planned: the in-process stub over `wasm-wasi-core` stdio (`stubDebuggee.ts`) and, later, the custom
 * Worker runner (guard bits in shared memory, `Atomics.wait` pauses). The controller must not know which one it has,
 * so everything the stub cannot do is a flag in `capabilities` that the controller turns into a clear DAP error.
 *
 * Breakpoints are guard addresses (`scanProgram().guardSites` keys), the same handle both hosts arm. Frames come
 * innermost first and carry the DWARF pc of the last instrumented block run in that frame; for outer frames that is
 * the block holding the call, which can start on an earlier line than the call itself.
 *
 * Calls are not reentrant. `start` and `resume` return once the command is sent; the outcome arrives as an event.
 */

export type ResumeKind = 'continue' | 'into' | 'over' | 'out';

/** `start` is the held-at-startup stop, before any user code; it has no frames. */
export type StopReason = 'start' | 'breakpoint' | 'step' | 'pause';

export interface DebuggeeFrame {
	funcIndex: number;
	/** DWARF code address (offset into the CODE section payload). */
	pc: number;
	/** The frame's `__stack_pointer`; identifies the frame while it lives. */
	sp: number;
}

export type DebuggeeEvent =
	| { kind: 'stopped'; reason: StopReason; frames: DebuggeeFrame[] }
	| { kind: 'exited'; exitCode: number }
	| { kind: 'output'; stream: 'stdout' | 'stderr'; text: string }
	| { kind: 'error'; message: string };

export interface DebuggeeCapabilities {
	/** `pause()` works while the program runs free. */
	pause: boolean;
	/** `setBreakpoints()` works while the program runs free (otherwise only at a stop). */
	breakpointsWhileRunning: boolean;
}

export interface DebuggeeSession {
	readonly capabilities: DebuggeeCapabilities;
	/** Receives every event, in order; set before `start`. */
	listener: ((event: DebuggeeEvent) => void) | undefined;
	/** Begins the session; the first event is a `stopped` with reason `start`. */
	start(): Promise<void>;
	setBreakpoints(guards: number[]): Promise<void>;
	resume(how: ResumeKind): Promise<void>;
	pause(): Promise<void>;
	/** Reads the stopped program's memory; undefined if the range is unreadable. */
	readMemory(addr: number, len: number): Promise<Uint8Array | undefined>;
	terminate(): Promise<void>;
}
