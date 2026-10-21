import { BreakpointIndex } from './breakpointIndex';
import type { DebuggeeEvent, DebuggeeFrame, DebuggeeSession, ResumeKind } from './debuggeeSession';
import { parseLineTable } from './dwarfLines';
import { PAGE_SIZE, PagedMemory, evaluateWithMemory } from './pagedMemory';
import type { PathMapper } from './pathMapper';
import type { ReactorHost, StopFrame } from './reactorHost';
import type { ScanResult } from './wasmScan';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;
interface Request { seq: number; type: string; command: string; arguments?: Args }

/** Everything `launch` produces: a built program held at startup, plus the lldb and path plumbing for it. */
export interface DebugTarget {
	session: DebuggeeSession;
	/** Already holding the program's DWARF (`createTarget`). */
	reactor: ReactorHost;
	program: Uint8Array;
	scan: ScanResult;
	paths: PathMapper;
}

export interface DebugControllerOptions {
	/** Builds and starts the program; it must be held before any user code (the first event is a `start` stop). */
	launch(args: Args): Promise<DebugTarget>;
	send(message: object): void;
}

interface Location { file: string; line: number }
interface StopState {
	frames: DebuggeeFrame[];
	/** Frames lldb can decode (those with a frame-base local), innermost first; DAP frame ids index into this. */
	lldbFrames: (StopFrame & { funcIndex: number })[];
}
interface StepState { kind: 'into' | 'over'; sp: number; location: Location | undefined }

const THREAD_ID = 1;

/**
 * The Debug Adapter Protocol logic, independent of both VS Code and the debuggee's host; vscode-free, so node tests
 * drive it with a real stub program and the real lldb reactor.
 *
 * `launch` runs the build and hands back a `DebugTarget` held at startup. `initialized` is sent only then, so the
 * client's `setBreakpoints` arrive while the program is still held and are armed before any user code runs; the run
 * starts at `configurationDone`.
 *
 * Limits that come from the hosts, not from this class: stops are at basic-block starts, so a line breakpoint in the
 * middle of a block stops at the block's first line (the response says so) and stepping moves block to block;
 * `pause` and breakpoint changes while running need a host with the matching `capabilities` (breakpoint changes are
 * queued to the next stop otherwise); the Variables pane cannot list locals because the reactor cannot enumerate
 * them, but hover, Watch and the Debug Console evaluate variable paths (`x`, `p.y`, `arr[2]`).
 */
export class DebugController {
	private seq = 1;
	private target: DebugTarget | undefined;
	private breakpoints: BreakpointIndex | undefined;
	private readonly guardsBySource = new Map<string, number[]>();
	private armedKey = '';
	private readonly memory = new PagedMemory();
	private readonly locations = new Map<number, Location | undefined>();
	private stop: StopState | undefined;
	private stepping: StepState | undefined;
	private running = false;
	private finished = false;
	private stopOnEntry = false;
	private entryPending = false;
	private onStart: { resolve(): void; reject(e: Error): void } | undefined;
	private events: Promise<void> = Promise.resolve();

	constructor(private readonly options: DebugControllerOptions) {}

	handleMessage(message: unknown): void {
		const req = message as Request;
		if (req.type !== 'request') { return; }
		void this.handleRequest(req).catch(err => this.respond(req, false, { message: err instanceof Error ? err.message : String(err) }));
	}

	private async handleRequest(req: Request): Promise<void> {
		const args = req.arguments ?? {};
		switch (req.command) {
			case 'initialize':
				this.respond(req, true, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsEvaluateForHovers: true });
				return;
			case 'launch': return this.launch(req, args);
			case 'setBreakpoints': return this.setBreakpoints(req, args);
			case 'setExceptionBreakpoints': this.respond(req, true, {}); return;
			case 'configurationDone':
				this.respond(req, true, {});
				return this.begin();
			case 'threads': this.respond(req, true, { threads: [{ id: THREAD_ID, name: 'main' }] }); return;
			case 'continue': return this.resumeFromRequest(req, 'continue', { allThreadsContinued: true });
			case 'next': return this.resumeFromRequest(req, 'over', {});
			case 'stepIn': return this.resumeFromRequest(req, 'into', {});
			case 'stepOut': return this.resumeFromRequest(req, 'out', {});
			case 'pause':
				await this.requireTarget().session.pause();
				this.respond(req, true, {});
				return;
			case 'stackTrace': return this.stackTrace(req, args);
			case 'scopes': this.respond(req, true, { scopes: [{ name: 'Locals', variablesReference: Number(args.frameId), expensive: false }] }); return;
			case 'variables': this.respond(req, true, { variables: [PLACEHOLDER_VARIABLE] }); return;
			case 'evaluate': return this.evaluate(req, args);
			case 'terminate':
			case 'disconnect':
				await this.target?.session.terminate();
				this.respond(req, true, {});
				if (req.command === 'terminate') { this.finish(); }
				return;
			default:
				throw new Error(`vscwClang debug adapter: DAP request '${req.command}' is not implemented. Did you mean one of: launch, setBreakpoints, continue, next, stepIn, stepOut, stackTrace, evaluate?`);
		}
	}

	private requireTarget(): DebugTarget {
		if (!this.target) { throw new Error('vscwClang: the debug session has not been launched yet; did the launch request fail?'); }
		return this.target;
	}

	private requireStopped(what: string): StopState {
		if (this.finished) { throw new Error(`vscwClang: cannot ${what}; the program has exited.`); }
		if (!this.stop) { throw new Error(`vscwClang: cannot ${what} while the program is running; the debugger only has the program's state at a stop.`); }
		return this.stop;
	}

	private async launch(req: Request, args: Args): Promise<void> {
		this.stopOnEntry = args.stopOnEntry === true;
		const started = new Promise<void>((resolve, reject) => { this.onStart = { resolve, reject }; });
		const target = await this.options.launch(args);
		this.target = target;
		target.session.listener = event => { this.events = this.events.then(() => this.onEvent(event)).catch(e => this.fail(e)); };
		this.breakpoints = new BreakpointIndex(parseLineTable(target.program, target.scan.module.customSections), target.scan.guardSites, target.scan.module);
		await target.session.start();
		await started;
		this.send({ type: 'event', event: 'initialized' });
		this.respond(req, true, {});
	}

	private async setBreakpoints(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const wanted: number[] = (args.breakpoints as { line: number }[] | undefined)?.map(b => b.line) ?? args.lines ?? [];
		const sourcePath = String(args.source?.path ?? '');
		const guest = target.paths.dapToGuest(sourcePath);
		const guardsHere: number[] = [];
		const results = wanted.map(line => {
			if (guest === undefined) { return { verified: false, line, message: `${sourcePath} is outside the workspace folder, which is all the debugger can map to the program's sources.` }; }
			const file = this.dwarfFileFor(guest);
			const resolved = file === undefined ? undefined : this.breakpoints!.resolve(file, line);
			if (!resolved) { return { verified: false, line, message: `no code at or after line ${line} of ${guest}; did you mean to build in debug mode, or is this file part of the program?` }; }
			guardsHere.push(...resolved.guards);
			const message = resolved.stopsAtLine === undefined ? undefined : `Stops when the block containing this line starts (line ${resolved.stopsAtLine}); the debugger can only stop at block starts.`;
			return { verified: true, line: resolved.line, ...(message ? { message } : {}) };
		});
		this.guardsBySource.set(guest ?? sourcePath, guardsHere);
		this.respond(req, true, { breakpoints: results });
		await this.syncBreakpoints();
	}

	/** The program's DWARF names a file the way it was compiled (`/workspace/a.cpp`), which can differ by a `./` from the client's. */
	private dwarfFileFor(guest: string): string | undefined {
		const files = this.breakpoints!.files();
		// A DWARF 4 line table names a file relative to a compile dir it does not carry, so also accept a suffix match on a relative name.
		return files.find(f => f === guest) ?? files.find(f => f.replace(/\/\.\//g, '/') === guest)
			?? files.find(f => !/^([/\\]|[A-Za-z]:|\w+:\/\/)/.test(f) && guest.endsWith('/' + f.replace(/^\.\//, '')));
	}

	/** Arms the union of every source's guards, unless the host cannot take commands while the program runs (then at the next stop). */
	private async syncBreakpoints(): Promise<void> {
		const session = this.requireTarget().session;
		if (this.running && !session.capabilities.breakpointsWhileRunning) { return; }
		const all = [...new Set([...this.guardsBySource.values()].flat())].sort((a, b) => a - b);
		const key = all.join(',');
		if (key === this.armedKey) { return; }
		await session.setBreakpoints(all);
		this.armedKey = key;
	}

	private async begin(): Promise<void> {
		this.entryPending = this.stopOnEntry;
		await this.resume(this.stopOnEntry ? 'into' : 'continue');
	}

	private async resumeFromRequest(req: Request, how: ResumeKind, body: object): Promise<void> {
		const stop = this.requireStopped(how === 'continue' ? 'continue' : `step (${how})`);
		const top = stop.frames[0];
		this.stepping = (how === 'into' || how === 'over') && top ? { kind: how, sp: top.sp, location: this.locate(top.pc) } : undefined;
		this.respond(req, true, body);
		await this.resume(how);
	}

	private async resume(how: ResumeKind): Promise<void> {
		await this.syncBreakpoints();
		this.running = true;
		this.stop = undefined;
		await this.requireTarget().session.resume(how);
	}

	private async onEvent(event: DebuggeeEvent): Promise<void> {
		switch (event.kind) {
			case 'output': this.send({ type: 'event', event: 'output', body: { category: event.stream, output: event.text } }); return;
			case 'error': this.fail(new Error(event.message)); return;
			case 'exited':
				this.onStart?.reject(new Error(`the program exited with code ${event.exitCode} before it could be debugged`));
				this.send({ type: 'event', event: 'exited', body: { exitCode: event.exitCode } });
				this.finish();
				return;
			case 'stopped': return this.onStopped(event);
		}
	}

	private async onStopped(event: Extract<DebuggeeEvent, { kind: 'stopped' }>): Promise<void> {
		this.running = false;
		if (event.reason === 'start') { this.onStart?.resolve(); this.onStart = undefined; return; }
		const step = this.stepping;
		if (event.reason === 'step' && step) {
			const top = event.frames[0];
			const here = top ? this.locate(top.pc) : undefined;
			if (top && top.sp === step.sp && here && step.location && here.file === step.location.file && here.line === step.location.line) {
				await this.resume(step.kind); // still on the same line, in the same frame: block-level hooks fire more than once per line
				return;
			}
		}
		this.stepping = undefined;
		const target = this.requireTarget();
		const lldbFrames = event.frames.filter(f => target.scan.frameBaseLocals.has(f.funcIndex)).map(f => ({ funcIndex: f.funcIndex, pc: f.pc, sp: f.sp, frameBaseLocal: target.scan.frameBaseLocals.get(f.funcIndex)! }));
		this.stop = { frames: event.frames, lldbFrames };
		this.memory.clear();
		target.reactor.setMemory({ read: this.memory.read });
		target.reactor.setStop(lldbFrames);
		await this.syncBreakpoints();
		const reason = event.reason === 'step' && this.entryPending ? 'entry' : event.reason;
		this.entryPending = false;
		this.send({ type: 'event', event: 'stopped', body: { reason, threadId: THREAD_ID, allThreadsStopped: true } });
	}

	private locate(pc: number): Location | undefined {
		if (!this.locations.has(pc)) {
			let location: Location | undefined;
			try {
				const match = /^(.*):(\d+)$/.exec(this.requireTarget().reactor.resolvePc(pc));
				if (match) { location = { file: match[1], line: Number(match[2]) }; }
			} catch { /* no line info for this pc */ }
			this.locations.set(pc, location);
		}
		return this.locations.get(pc);
	}

	private async stackTrace(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const stop = this.requireStopped('read the stack');
		const start = Number(args.startFrame ?? 0), levels = Number(args.levels ?? 0) || stop.lldbFrames.length;
		const frames = stop.lldbFrames.map((f, i) => {
			const location = this.locate(f.pc);
			const dapPath = location && target.paths.guestToDap(location.file);
			const name = target.scan.module.names.get(f.funcIndex) ?? `wasm-function[${f.funcIndex}]`;
			const source = location ? { name: location.file.slice(Math.max(location.file.lastIndexOf('/'), location.file.lastIndexOf('\\')) + 1), ...(dapPath ? { path: dapPath } : {}) } : undefined;
			return { id: i + 1, name, ...(source ? { source } : {}), line: location?.line ?? 0, column: 1 };
		});
		this.respond(req, true, { stackFrames: frames.slice(start, start + levels), totalFrames: frames.length });
	}

	private async evaluate(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const stop = this.requireStopped('evaluate');
		const frame = args.frameId === undefined ? 0 : Number(args.frameId) - 1;
		const expression = String(args.expression ?? '').trim();
		const result = await evaluateWithMemory(this.memory, pages => this.fetchPages(pages), () => target.reactor.formatValue(frame, expression), () => target.reactor.setStop(stop.lldbFrames));
		this.respond(req, true, { result, variablesReference: 0 });
	}

	private async fetchPages(pages: number[]): Promise<void> {
		const session = this.requireTarget().session;
		for (const page of pages) {
			if (!this.memory.has(page)) { this.memory.set(page, await session.readMemory(page * PAGE_SIZE, PAGE_SIZE) ?? null); }
		}
	}

	/** The session cannot continue (stub error, spawn failure): tell the client and end it. */
	private fail(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.onStart?.reject(new Error(message));
		this.onStart = undefined;
		this.send({ type: 'event', event: 'output', body: { category: 'stderr', output: `vscwClang: ${message}\n` } });
		this.finish();
	}

	private finish(): void {
		if (this.finished) { return; }
		this.finished = true;
		this.stop = undefined;
		this.send({ type: 'event', event: 'terminated' });
	}

	private respond(req: Request, success: boolean, body: object): void {
		this.send(success
			? { type: 'response', request_seq: req.seq, command: req.command, success, body }
			: { type: 'response', request_seq: req.seq, command: req.command, success, ...body });
	}

	private send(message: object): void { this.options.send({ seq: this.seq++, ...message }); }
}

const PLACEHOLDER_VARIABLE = {
	name: '(locals not listed)',
	value: 'hover a name, or use Watch or the Debug Console, to evaluate x, p.y or arr[2]',
	variablesReference: 0,
};
