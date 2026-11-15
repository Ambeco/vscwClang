import type { DebuggeeEvent, DebuggeeFrame, DebuggeeSession, DebuggeeThread, ResumeKind } from './debuggeeSession';
import { StubSession } from './stubChannel';
import { readStubThreads } from './stubRegistry';
import { pickTrappedThread, refineFrames, type TrapInput } from './trapStop';
import type { GuardSite } from './wasmScan';

export interface StubDebuggeeOptions {
	/** Writes command text to the program's stdin. */
	send(text: string): void | Promise<void>;
	/** Writes program input (bytes the program itself should read) to the program's stdin; same pipe as `send`, so calls stay ordered. */
	sendInput?(data: Uint8Array): void | Promise<void>;
	/** Receives the program's stdout and stderr text instead of the session's listener (e.g. to show it in a terminal). */
	onOutput?(stream: 'stdout' | 'stderr', text: string): void;
	/** Settles with the exit code when the program ends. */
	exited: Promise<number>;
	terminate(): void | Promise<void>;
	guardSites: Map<number, GuardSite>;
	/** The program's shared linear memory (threaded programs); enables breakpoint changes, Pause and all-stop while it runs, and traps as stops. */
	memory?: WebAssembly.Memory;
	/** Offset of the code section payload (`ScanResult.module.codeStart`); lets a trap's stack trace give exact pcs. */
	codeStart?: number;
}

/** The bit of the stub's control word that parks every thread (`CTL_STOPPED` in `debugStub.c`). */
const CTL_STOPPED = 2;

/** Longer than any wait a user will sit through, but under `setTimeout`'s 2^31 ms limit. */
const FOREVER_MS = 2_000_000_000;

/**
 * `DebuggeeSession` over the in-process debug stub (`debugStub.c`) and its stdio channel (`stubChannel.ts`).
 *
 * The process owner feeds the program's stdout and stderr chunks to `feedStdout`/`feedStderr`. The stub only reads
 * commands at stops, so over the channel alone breakpoint changes and pause cannot reach a program that is running
 * free: `capabilities` says so and the controller queues changes until the next stop. With `options.memory` (a
 * threaded program's shared memory) the host instead writes the breakpoint bit of each guard word directly, and
 * Pause sets the stub's pause flag; the stub stops at the next guard any thread runs. From the first `setBreakpoints`
 * on the host owns the bits, so the `bp` command is never mixed in. A program blocked in `std::cin`, a sleep or a
 * lock does not reach a guard, so Pause waits until it does.
 *
 * With shared memory a stop is also an all-stop: every other thread parks at its next guard, and `threads()` reads
 * each parked thread's shadow stack out of the stub's registry (`stubRegistry.ts`). A blocked thread (see above) is
 * listed as not stopped, with no frames; it parks later if it reaches a guard while the program is still stopped.
 *
 * A trap in the program (`holdTrap`, called by the process owner) becomes a stop with reason `exception`: the host
 * parks the other threads itself, finds the trapped thread's shadow stack in the registry (`trapStop.ts`), and reads
 * memory straight from the shared `WebAssembly.Memory`, since the stub never runs again. The program cannot
 * continue: any resume ends it (`options.terminate`), which the owner reports as a trap exit.
 *
 * `writeInput` forwards what the user types to the program: straight to the pipe while the program runs, queued
 * while it is stopped (the stub would read it as a command). Input forwarded just before a stop may still sit
 * unread in the pipe, and the stub then hands it back (`input` frames); the next resume therefore first `sync`s so
 * those bytes are back in the queue, in order, before it sends the resume command and then the queue.
 */
export class StubDebuggee implements DebuggeeSession {
	listener: ((event: DebuggeeEvent) => void) | undefined;
	/** Guard words whose breakpoint bit the host has set in shared memory. */
	private readonly armedInMemory = new Set<number>();
	private readonly session: StubSession;
	private readonly stdoutDecoder = new TextDecoder();
	private readonly stderrDecoder = new TextDecoder();
	private done = false;
	private waiting = false;
	private queuedInput: Uint8Array[] = [];
	/** Leading entries of `queuedInput` the stub handed back; later typing goes after them. */
	private handedBack = 0;
	/** Program input was written while running since the last resume, so the stub may still hold some. */
	private inputInFlight = false;
	/** A trap is being shown as a stop: the stub is gone, so only memory reads and ending the program work. */
	private trapped = false;
	/** The latest stop's thread and stack, which `threads()` reports as is. */
	private lastStop: { threadId: number; frames: DebuggeeFrame[] } | undefined;

	constructor(private readonly options: StubDebuggeeOptions) {
		this.session = new StubSession(options.send, b => this.emit({ kind: 'output', stream: 'stderr', text: this.stderrDecoder.decode(b, { stream: true }) }), b => this.onHandedBack(b));
		void options.exited.then(code => this.onExit(code), e => { this.emit({ kind: 'error', message: `the program failed to run: ${e instanceof Error ? e.message : String(e)}` }); this.onExit(undefined); });
	}

	/** Meaningful once the stub's `hello` has arrived (the start stop). */
	get capabilities() {
		const memory = this.options.memory !== undefined;
		return { pause: memory && this.session.pauseFlag !== undefined, breakpointsWhileRunning: memory, allStop: memory && this.session.registry !== undefined };
	}

	feedStdout(chunk: Uint8Array): void { this.emit({ kind: 'output', stream: 'stdout', text: this.stdoutDecoder.decode(chunk, { stream: true }) }); }
	feedStderr(chunk: Uint8Array): void { this.session.onStderr(chunk); }

	async start(): Promise<void> { this.awaitStop(); }

	async setBreakpoints(guards: number[]): Promise<void> {
		const memory = this.options.memory;
		if (!memory) {
			this.requireStopped('set breakpoints');
			await this.session.setBreakpoints(guards);
			return;
		}
		if (!this.session.guardRange) { throw new Error('vscwClang: cannot set breakpoints before the program has reached its debug stub (its shared memory is initialised after startup and would erase them).'); }
		// A fresh view each time: growing the memory replaces its buffer.
		const words = new Uint32Array(memory.buffer);
		const wanted = new Set(guards);
		for (const guard of this.armedInMemory) {
			if (!wanted.has(guard)) { Atomics.and(words, guard >>> 2, ~1); this.armedInMemory.delete(guard); }
		}
		for (const guard of wanted) {
			if (guard % 4 !== 0 || guard >>> 2 >= words.length) { throw new Error(`vscwClang: guard address ${guard} is not a word inside the program's memory; did the program and debug stub drift apart?`); }
			Atomics.or(words, guard >>> 2, 1);
			this.armedInMemory.add(guard);
		}
	}

	async resume(how: ResumeKind): Promise<void> {
		if (this.trapped) {
			// The trapped thread cannot continue; ending the process reports the trap as its exit.
			await this.options.terminate();
			return;
		}
		this.requireStopped('resume');
		this.lastStop = undefined;
		if (this.inputInFlight) { await this.session.sync(); }
		this.inputInFlight = false;
		await this.session.resume(how === 'continue' ? 'go' : how);
		// No await from here to the send: input typed from now on goes straight to the pipe, after what was queued.
		const queued = this.queuedInput;
		this.queuedInput = [];
		this.handedBack = 0;
		this.awaitStop();
		if (queued.length > 0) { await this.sendProgramInput(concat(queued)); }
	}

	/** Forwards typed program input: to the pipe while the program runs, else queued until it resumes. */
	async writeInput(data: Uint8Array): Promise<void> {
		if (this.done || data.length === 0) { return; }
		if (this.waiting) { await this.sendProgramInput(data); } else { this.queuedInput.push(data); }
	}

	private sendProgramInput(data: Uint8Array): void | Promise<void> {
		if (!this.options.sendInput) { throw new Error('vscwClang: this debug host cannot forward program input; did you mean to pass sendInput?'); }
		this.inputInFlight = true;
		return this.options.sendInput(data);
	}

	private onHandedBack(data: Uint8Array): void {
		if (this.waiting) { void this.sendProgramInput(data); return; }
		this.queuedInput.splice(this.handedBack++, 0, data);
	}

	async pause(): Promise<void> {
		const memory = this.options.memory;
		const flag = this.session.pauseFlag;
		if (!memory || flag === undefined) {
			throw new Error('vscwClang cannot pause this program: Pause needs the shared memory of a threaded debug build (is vscwclang.threads off?) and a current debug stub. Set a breakpoint and continue instead.');
		}
		Atomics.or(new Uint32Array(memory.buffer), flag >>> 2, 1);
	}

	async threads(): Promise<DebuggeeThread[]> {
		const registry = this.session.registry;
		if (!this.options.memory || !registry) {
			return this.lastStop ? [{ id: this.lastStop.threadId, stopped: true, frames: this.lastStop.frames }] : [];
		}
		return readStubThreads(this.options.memory.buffer, registry).map(t => ({
			id: t.id,
			stopped: t.state === 'parked' || t.id === this.lastStop?.threadId,
			frames: t.id === this.lastStop?.threadId ? this.lastStop.frames : this.mapFrames(t.frames),
		}));
	}

	async readMemory(addr: number, len: number): Promise<Uint8Array | undefined> {
		if (this.trapped) {
			const bytes = new Uint8Array(this.options.memory!.buffer);
			return addr >= 0 && len >= 0 && addr + len <= bytes.length ? bytes.slice(addr, addr + len) : undefined;
		}
		this.requireStopped('read memory');
		return this.session.readMemory(addr, len);
	}

	async terminate(): Promise<void> {
		this.done = true;
		this.session.close();
		await this.options.terminate();
	}

	private requireStopped(what: string): void {
		if (this.waiting) { throw new Error(`vscwClang: cannot ${what} while the program is running; the debug stub only accepts commands at a stop.`); }
	}

	private emit(event: DebuggeeEvent): void {
		if (event.kind === 'output') {
			if (event.text === '') { return; }
			if (this.options.onOutput) { this.options.onOutput(event.stream, event.text); return; }
		}
		this.listener?.(event);
	}

	private awaitStop(): void {
		this.waiting = true;
		void this.session.nextStop(FOREVER_MS).then(stop => {
			this.waiting = false;
			if (this.trapped) { return; }
			const frames = this.mapFrames(stop.frames);
			this.lastStop = { threadId: stop.threadId, frames };
			this.emit({ kind: 'stopped', reason: stop.reason as 'start' | 'breakpoint' | 'step' | 'pause', threadId: stop.threadId, frames });
		}, e => {
			this.waiting = false;
			if (!this.done) { this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) }); }
		});
	}

	/**
	 * Takes a trap over as a stop. Returns false (the process then ends as it always did) when it cannot: no shared
	 * memory, the stub has not reached its start stop, or the session is over.
	 */
	holdTrap(trap: TrapInput & { message: string; stack?: string }): boolean {
		if (this.done || this.trapped || !this.options.memory || !this.session.registry) { return false; }
		this.trapped = true;
		void this.reportTrap(trap).catch(e => this.emit({ kind: 'error', message: `could not show the trap as a stop: ${e instanceof Error ? e.message : String(e)}` }));
		return true;
	}

	private async reportTrap(trap: TrapInput & { message: string; stack?: string }): Promise<void> {
		const memory = this.options.memory!, registry = this.session.registry!;
		const flag = this.session.pauseFlag;
		// The stub's own stop would park the other threads; the trapped thread never reaches it, so do that here.
		if (flag !== undefined) { Atomics.or(new Uint32Array(memory.buffer), flag >>> 2, CTL_STOPPED); }
		for (let i = 0; i < 6 && readStubThreads(memory.buffer, registry).filter(t => t.state === 'running').length > 1; i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const trapped = pickTrappedThread(readStubThreads(memory.buffer, registry, { framesOfRunning: true }), trap);
		const frames = refineFrames(this.mapFrames(trapped?.frames ?? []), trap.stack, this.options.codeStart);
		this.waiting = false;
		this.lastStop = { threadId: trapped?.id ?? 1, frames };
		this.emit({ kind: 'stopped', reason: 'exception', threadId: this.lastStop.threadId, frames, text: trap.message });
	}

	private mapFrames(raw: { guard: number; sp: number }[]): DebuggeeFrame[] {
		return raw.map(f => {
			const site = this.options.guardSites.get(f.guard);
			if (!site) { throw new Error(`the debug stub reported guard ${f.guard}, which is not in the program's coverage table; did the program and debug stub drift apart?`); }
			return { funcIndex: site.funcIndex, pc: site.pc, sp: f.sp };
		});
	}

	private onExit(code: number | undefined): void {
		if (this.done) { return; }
		this.done = true;
		this.session.close();
		this.session.endStderr();
		const tail = this.stderrDecoder.decode();
		if (tail) { this.emit({ kind: 'output', stream: 'stderr', text: tail }); }
		if (code !== undefined) { this.emit({ kind: 'exited', exitCode: code }); }
	}
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	chunks.reduce((at, c) => { all.set(c, at); return at + c.length; }, 0);
	return all;
}
