import type { DebuggeeEvent, DebuggeeSession, ResumeKind } from './debuggeeSession';
import { StubSession } from './stubChannel';
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
}

/** Longer than any wait a user will sit through, but under `setTimeout`'s 2^31 ms limit. */
const FOREVER_MS = 2_000_000_000;

/**
 * `DebuggeeSession` over the in-process debug stub (`debugStub.c`) and its stdio channel (`stubChannel.ts`).
 *
 * The process owner feeds the program's stdout and stderr chunks to `feedStdout`/`feedStderr`. The stub only reads
 * commands at stops, so breakpoint changes and pause cannot reach a program that is running free: `capabilities`
 * says so and the controller queues changes until the next stop.
 *
 * `writeInput` forwards what the user types to the program: straight to the pipe while the program runs, queued
 * while it is stopped (the stub would read it as a command). Input forwarded just before a stop may still sit
 * unread in the pipe, and the stub then hands it back (`input` frames); the next resume therefore first `sync`s so
 * those bytes are back in the queue, in order, before it sends the resume command and then the queue.
 */
export class StubDebuggee implements DebuggeeSession {
	readonly capabilities = { pause: false, breakpointsWhileRunning: false };
	listener: ((event: DebuggeeEvent) => void) | undefined;
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

	constructor(private readonly options: StubDebuggeeOptions) {
		this.session = new StubSession(options.send, b => this.emit({ kind: 'output', stream: 'stderr', text: this.stderrDecoder.decode(b, { stream: true }) }), b => this.onHandedBack(b));
		void options.exited.then(code => this.onExit(code), e => { this.emit({ kind: 'error', message: `the program failed to run: ${e instanceof Error ? e.message : String(e)}` }); this.onExit(undefined); });
	}

	feedStdout(chunk: Uint8Array): void { this.emit({ kind: 'output', stream: 'stdout', text: this.stdoutDecoder.decode(chunk, { stream: true }) }); }
	feedStderr(chunk: Uint8Array): void { this.session.onStderr(chunk); }

	async start(): Promise<void> { this.awaitStop(); }

	async setBreakpoints(guards: number[]): Promise<void> {
		this.requireStopped('set breakpoints');
		await this.session.setBreakpoints(guards);
	}

	async resume(how: ResumeKind): Promise<void> {
		this.requireStopped('resume');
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

	pause(): Promise<void> {
		return Promise.reject(new Error('vscwClang cannot pause a program that is running: the debug stub only reads commands at stops. Set a breakpoint and continue instead; pausing needs the custom runner.'));
	}

	async readMemory(addr: number, len: number): Promise<Uint8Array | undefined> {
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
			const frames = stop.frames.map(f => {
				const site = this.options.guardSites.get(f.guard);
				if (!site) { throw new Error(`the debug stub reported guard ${f.guard}, which is not in the program's coverage table; did the program and debug stub drift apart?`); }
				return { funcIndex: site.funcIndex, pc: site.pc, sp: f.sp };
			});
			this.emit({ kind: 'stopped', reason: stop.reason as 'start' | 'breakpoint' | 'step' | 'pause', frames });
		}, e => {
			this.waiting = false;
			if (!this.done) { this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) }); }
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
