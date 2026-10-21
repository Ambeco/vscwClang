import type { DebuggeeEvent, DebuggeeSession, ResumeKind } from './debuggeeSession';
import { StubSession } from './stubChannel';
import type { GuardSite } from './wasmScan';

export interface StubDebuggeeOptions {
	/** Writes command text to the program's stdin. */
	send(text: string): void | Promise<void>;
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
 */
export class StubDebuggee implements DebuggeeSession {
	readonly capabilities = { pause: false, breakpointsWhileRunning: false };
	listener: ((event: DebuggeeEvent) => void) | undefined;
	private readonly session: StubSession;
	private readonly stdoutDecoder = new TextDecoder();
	private readonly stderrDecoder = new TextDecoder();
	private done = false;
	private waiting = false;

	constructor(private readonly options: StubDebuggeeOptions) {
		this.session = new StubSession(options.send, b => this.emit({ kind: 'output', stream: 'stderr', text: this.stderrDecoder.decode(b, { stream: true }) }));
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
		await this.session.resume(how === 'continue' ? 'go' : how);
		this.awaitStop();
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
		if (event.kind === 'output' && event.text === '') { return; }
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
