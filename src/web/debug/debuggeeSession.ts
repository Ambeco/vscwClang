/**
 * What the DAP controller (`debugController.ts`) needs from a running debuggee, whatever hosts it; vscode-free.
 *
 * Today's host is the in-process stub (`stubDebuggee.ts`). The controller must not know which host it has, so
 * everything a host cannot do is a flag in `capabilities` that the controller turns into a clear DAP error. The stub
 * host can pause, edit breakpoints live and stop every thread at a stop (all-stop) only for programs with shared memory.
 *
 * Breakpoints are guard addresses (`scanProgram().guardSites` keys), the same handle both hosts arm. Frames come
 * innermost first and carry the DWARF pc of the last instrumented block run in that frame; for outer frames that is
 * the block holding the call, which can start on an earlier line than the call itself.
 *
 * Calls are not reentrant. `start` and `resume` return once the command is sent; the outcome arrives as an event.
 */

export type ResumeKind = 'continue' | 'into' | 'over' | 'out';

/** `start` is the held-at-startup stop, before any user code; it has no frames. `exception` is a trap (the program cannot resume) or an abort before the exit 134 (it can). */
export type StopReason = 'start' | 'breakpoint' | 'step' | 'pause' | 'exception';

export interface DebuggeeFrame {
	funcIndex: number;
	/** DWARF code address (offset into the CODE section payload). */
	pc: number;
	/** The frame's `__stack_pointer`; identifies the frame while it lives. */
	sp: number;
}

export type DebuggeeEvent =
	| { kind: 'stopped'; reason: StopReason; /** 1 is the main thread. */ threadId: number; frames: DebuggeeFrame[]; /** For `exception`: what the engine said. */ text?: string }
	| { kind: 'exited'; exitCode: number }
	| { kind: 'output'; stream: 'stdout' | 'stderr'; text: string }
	| { kind: 'error'; message: string };

export interface DebuggeeCapabilities {
	/** `pause()` works while the program runs free. */
	pause: boolean;
	/** `setBreakpoints()` works while the program runs free (otherwise only at a stop). */
	breakpointsWhileRunning: boolean;
	/** A stop halts every thread, and `threads()` lists them with their stacks. */
	allStop: boolean;
}

export interface DebuggeeThread {
	/** The id used in `stopped` events (1 is main). */
	id: number;
	/** False for a thread that did not reach a stop point in time: blocked in a lock, sleep, `join` or `cin`, or just slow. */
	stopped: boolean;
	/** Innermost first. For a thread that is not stopped, the stack as of its last statement (the call that blocks is in its top frame); empty if unreadable. */
	frames: DebuggeeFrame[];
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
	/** Every live thread with its stack, valid at a stop; with `capabilities.allStop` false only the stopped thread is known. */
	threads(): Promise<DebuggeeThread[]>;
	/** Reads the stopped program's memory; undefined if the range is unreadable. */
	readMemory(addr: number, len: number): Promise<Uint8Array | undefined>;
	terminate(): Promise<void>;
}
