import { BreakpointIndex } from './breakpointIndex';
import type { DebuggeeEvent, DebuggeeFrame, DebuggeeSession, ResumeKind } from './debuggeeSession';
import { evaluateExpression, formatLogMessage, hitConditionMatches, isPlainPath, scalarFromFormatted } from './debugExpression';
import { displayFunctionName, functionNameMatches } from './demangle';
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
	/** Shown in the Debug Console once launched, e.g. where the program's output went instead. */
	notice?: string;
}

export interface DebugControllerOptions {
	/** Builds and starts the program; it must be held before any user code (the first event is a `start` stop). */
	launch(args: Args): Promise<DebugTarget>;
	send(message: object): void;
}

interface Location { file: string; line: number }
interface StopState {
	threadId: number;
	frames: DebuggeeFrame[];
	/** Frames lldb can decode (those with a frame-base local), innermost first; DAP frame ids index into this. */
	lldbFrames: (StopFrame & { funcIndex: number })[];
}
/** What a DAP `variablesReference` stands for: a frame's variables (empty `path`) or one value's children. Valid for one stop. */
interface VariableRef { frame: number; path: string }
/** What a client attached to a breakpoint besides its place; `key` carries the hit count across the client's re-sends. */
interface BreakpointSpec { key: string; condition?: string; hitCondition?: string; logMessage?: string }
interface PlacedSpec { pcs: number[]; spec: BreakpointSpec }
interface SourceBreakpoint { line: number; condition?: string; hitCondition?: string; logMessage?: string }
interface FunctionBreakpoint { name: string; condition?: string; hitCondition?: string }
interface StepState { kind: 'into' | 'over'; sp: number; location: Location | undefined }

const MAIN_THREAD_ID = 1;

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
 * queued to the next stop otherwise); the Variables pane lists what lldb can read, which needs a toolchain built
 * with `-sanitizer-coverage-spill-debug-vars` (a by-value struct or VLA lives in a wasm local otherwise and shows the
 * reason instead of a value); hover, Watch and the Debug
 * Console evaluate variable paths (`x`, `p.y`, `arr[2]`) and C-like expressions over them (`debugExpression.ts`), which
 * are also what breakpoint conditions, hit counts and logpoints use.
 */
export class DebugController {
	private seq = 1;
	private target: DebugTarget | undefined;
	private breakpoints: BreakpointIndex | undefined;
	private readonly guardsBySource = new Map<string, number[]>();
	private readonly specsBySource = new Map<string, PlacedSpec[]>();
	private readonly hitCounts = new Map<string, number>();
	private armedKey = '';
	private readonly memory = new PagedMemory();
	private readonly locations = new Map<number, Location | undefined>();
	private stop: StopState | undefined;
	/** Threads that have stopped so far (and main); the stub reports a thread only when it stops. */
	private readonly threads = new Set<number>([MAIN_THREAD_ID]);
	private readonly variableRefs = new Map<number, VariableRef>();
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
				this.respond(req, true, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsEvaluateForHovers: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true, supportsFunctionBreakpoints: true });
				return;
			case 'launch': return this.launch(req, args);
			case 'setBreakpoints': return this.setBreakpoints(req, args);
			case 'setFunctionBreakpoints': return this.setFunctionBreakpoints(req, args);
			case 'setExceptionBreakpoints': this.respond(req, true, {}); return;
			case 'configurationDone':
				this.respond(req, true, {});
				return this.begin();
			case 'threads': this.respond(req, true, { threads: [...this.threads].map(id => ({ id, name: id === MAIN_THREAD_ID ? 'main' : `thread ${id}` })) }); return;
			case 'continue': return this.resumeFromRequest(req, 'continue', { allThreadsContinued: false }, args);
			case 'next': return this.resumeFromRequest(req, 'over', {}, args);
			case 'stepIn': return this.resumeFromRequest(req, 'into', {}, args);
			case 'stepOut': return this.resumeFromRequest(req, 'out', {}, args);
			case 'pause':
				await this.requireTarget().session.pause();
				this.respond(req, true, {});
				return;
			case 'stackTrace': return this.stackTrace(req, args);
			case 'scopes': return this.scopes(req, args);
			case 'variables': return this.variables(req, args);
			case 'evaluate': return this.evaluate(req, args);
			case 'terminate':
			case 'disconnect':
				await this.target?.session.terminate();
				this.target?.reactor.dispose();
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
		if (target.notice) { this.send({ type: 'event', event: 'output', body: { category: 'console', output: `${target.notice}\n` } }); }
		target.session.listener = event => { this.events = this.events.then(() => this.onEvent(event)).catch(e => this.fail(e)); };
		this.breakpoints = new BreakpointIndex(parseLineTable(target.program, target.scan.module.customSections), target.scan.guardSites, target.scan.module);
		await target.session.start();
		await started;
		this.send({ type: 'event', event: 'initialized' });
		this.respond(req, true, {});
	}

	private async setBreakpoints(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const requested: SourceBreakpoint[] = args.breakpoints ?? (args.lines as number[] | undefined)?.map(line => ({ line })) ?? [];
		const sourcePath = String(args.source?.path ?? '');
		const guest = target.paths.dapToGuest(sourcePath);
		const guardsHere: number[] = [];
		const placed: PlacedSpec[] = [];
		const results = requested.map(({ line, condition, hitCondition, logMessage }) => {
			if (guest === undefined) { return { verified: false, line, message: `${sourcePath} is outside the workspace folder, which is all the debugger can map to the program's sources.` }; }
			const file = this.dwarfFileFor(guest);
			const resolved = file === undefined ? undefined : this.breakpoints!.resolve(file, line);
			if (!resolved) { return { verified: false, line, message: `no code at or after line ${line} of ${guest}; did you mean to build in debug mode, or is this file part of the program?` }; }
			guardsHere.push(...resolved.guards);
			placed.push({ pcs: resolved.guards.map(g => target.scan.guardSites.get(g)!.pc), spec: { key: `${guest}:${resolved.line}`, condition: condition || undefined, hitCondition: hitCondition || undefined, logMessage: logMessage || undefined } });
			const message = resolved.stopsAtLine === undefined ? undefined : `Stops when the block containing this line starts (line ${resolved.stopsAtLine}); the debugger can only stop at block starts.`;
			return { verified: true, line: resolved.line, ...(message ? { message } : {}) };
		});
		this.guardsBySource.set(guest ?? sourcePath, guardsHere);
		this.specsBySource.set(guest ?? sourcePath, placed);
		this.respond(req, true, { breakpoints: results });
		await this.syncBreakpoints();
	}

	/**
	 * A function breakpoint matches the demangled name (`add`, `ns::add`, `Foo::bar` or `add(int, int)`) and stops
	 * at the function's first body line, where a step into it lands; the `{` entry guard is before the parameters are stored.
	 */
	private async setFunctionBreakpoints(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const requested: FunctionBreakpoint[] = args.breakpoints ?? [];
		const guards: number[] = [];
		const placed: PlacedSpec[] = [];
		const results = requested.map(({ name, condition, hitCondition }) => {
			const funcs = new Set([...target.scan.module.names].filter(([, n]) => functionNameMatches(n, name.trim())).map(([i]) => i));
			const sites = [...target.scan.guardSites].filter(([, s]) => funcs.has(s.funcIndex)).sort((a, b) => a[1].pc - b[1].pc);
			if (sites.length === 0) { return { verified: false, message: `no function named "${name}" has code in this program; did you mean its name with the namespace or class (ns::f, Foo::bar), or to build in debug mode?` }; }
			const picked = new Map<number, [number, number]>(); // function index -> [guard, pc] of its first body guard (else its only one)
			for (const [guard, site] of sites) {
				const have = picked.get(site.funcIndex);
				if (!have || (this.breakpoints!.isEntryGuard(have[1]) && !this.breakpoints!.isEntryGuard(site.pc))) { picked.set(site.funcIndex, [guard, site.pc]); }
			}
			guards.push(...[...picked.values()].map(p => p[0]));
			placed.push({ pcs: [...picked.values()].map(p => p[1]), spec: { key: `fn:${name}`, condition: condition || undefined, hitCondition: hitCondition || undefined } });
			const line = this.breakpoints!.lineAt([...picked.values()][0][1])?.line;
			return { verified: true, ...(line ? { line } : {}) };
		});
		this.guardsBySource.set('\0functions', guards);
		this.specsBySource.set('\0functions', placed);
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

	private async resumeFromRequest(req: Request, how: ResumeKind, body: object, args: Args): Promise<void> {
		const stop = this.requireStopped(how === 'continue' ? 'continue' : `step (${how})`);
		if (args.threadId !== undefined && Number(args.threadId) !== stop.threadId) {
			throw new Error(`vscwClang: thread ${args.threadId} is running; only thread ${stop.threadId} is stopped, and the debug stub resumes just the stopped thread. Did you mean to continue or step thread ${stop.threadId}?`);
		}
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
				await this.resume(step.kind); // still on the same line, in the same frame: several hooks can fire on one line
				return;
			}
			// A step into a call lands on the callee's entry guard, where the parameters are not stored yet; go on to its first line.
			if (top && step.kind === 'into' && top.sp < step.sp && this.breakpoints?.isEntryGuard(top.pc)) {
				await this.resume('into');
				return;
			}
		}
		const target = this.requireTarget();
		const lldbFrames = event.frames.filter(f => target.scan.frameBaseLocals.has(f.funcIndex)).map(f => ({ funcIndex: f.funcIndex, pc: f.pc, sp: f.sp, frameBaseLocal: target.scan.frameBaseLocals.get(f.funcIndex)! }));
		this.stop = { threadId: event.threadId, frames: event.frames, lldbFrames };
		if (!this.threads.has(event.threadId)) {
			this.threads.add(event.threadId);
			this.send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: event.threadId } });
		}
		this.variableRefs.clear();
		this.memory.clear();
		target.reactor.setMemory({ read: this.memory.read });
		target.reactor.setStop(lldbFrames);
		if (event.reason === 'breakpoint' && event.frames[0]) {
			const verdict = await this.breakpointVerdict(event.frames[0].pc);
			if (!verdict.stop) {
				// A condition, hit count or logpoint said not to stop: carry on with whatever the user was doing.
				this.stop = undefined;
				await this.resume(step?.kind ?? 'continue');
				return;
			}
			if (verdict.error) { this.send({ type: 'event', event: 'output', body: { category: 'important', output: `vscwClang: ${verdict.error}\n` } }); }
		}
		this.stepping = undefined;
		await this.syncBreakpoints();
		const reason = event.reason === 'step' && this.entryPending ? 'entry' : event.reason;
		this.entryPending = false;
		this.send({ type: 'event', event: 'stopped', body: { reason, threadId: event.threadId, allThreadsStopped: false } });
	}

	/**
	 * Decides whether the breakpoint(s) at `pc` really stop: the condition must hold, then the hit count (counting only
	 * hits whose condition held) must match, and a logpoint prints instead of stopping. A condition that cannot be
	 * evaluated stops, with the reason, so a typo is noticed rather than silently skipped.
	 */
	private async breakpointVerdict(pc: number): Promise<{ stop: boolean; error?: string }> {
		const specs = [...this.specsBySource.values()].flat().filter(p => p.pcs.includes(pc)).map(p => p.spec);
		if (specs.length === 0) { return { stop: true }; }
		let stop = false;
		let error: string | undefined;
		for (const spec of specs) {
			try {
				if (spec.condition && !await this.evaluateCondition(spec.condition)) { continue; }
				const hits = (this.hitCounts.get(spec.key) ?? 0) + 1;
				this.hitCounts.set(spec.key, hits);
				if (spec.hitCondition && !hitConditionMatches(spec.hitCondition, hits)) { continue; }
				if (spec.logMessage !== undefined) { await this.logPoint(spec.logMessage); continue; }
				stop = true;
			} catch (e) {
				stop = true;
				error = `breakpoint condition "${spec.condition ?? spec.hitCondition}" failed, so the program stopped: ${e instanceof Error ? e.message : String(e)}`;
			}
		}
		return { stop, error };
	}

	private async evaluateValue(expression: string, frame = 0) {
		const target = this.requireTarget();
		const stop = this.stop;
		return evaluateWithMemory(this.memory, pages => this.fetchPages(pages),
			() => evaluateExpression(expression, path => scalarFromFormatted(path, target.reactor.formatValue(frame, path))),
			() => { if (stop) { target.reactor.setStop(stop.lldbFrames); } });
	}

	private async evaluateCondition(condition: string): Promise<boolean> {
		const v = await this.evaluateValue(condition);
		return typeof v === 'boolean' ? v : v !== 0;
	}

	private async logPoint(template: string): Promise<void> {
		const expressions: string[] = [];
		formatLogMessage(template, expression => { expressions.push(expression); return ''; });
		const values: string[] = [];
		for (const expression of expressions) {
			values.push(await this.evaluateValue(expression).then(String, e => `<${e instanceof Error ? e.message : String(e)}>`));
		}
		let i = 0;
		this.send({ type: 'event', event: 'output', body: { category: 'console', output: `${formatLogMessage(template, () => values[i++])}\n` } });
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
		if (args.threadId !== undefined && Number(args.threadId) !== stop.threadId) {
			// Running threads have no frames to show: the stub reports a thread's stack only when it stops.
			this.respond(req, true, { stackFrames: [], totalFrames: 0 });
			return;
		}
		const start = Number(args.startFrame ?? 0), levels = Number(args.levels ?? 0) || stop.lldbFrames.length;
		const frames = stop.lldbFrames.map((f, i) => {
			const location = this.locate(f.pc);
			const dapPath = location && target.paths.guestToDap(location.file);
			const wasmName = target.scan.module.names.get(f.funcIndex);
			const name = wasmName === undefined ? `wasm-function[${f.funcIndex}]` : displayFunctionName(wasmName);
			const source = location ? { name: location.file.slice(Math.max(location.file.lastIndexOf('/'), location.file.lastIndexOf('\\')) + 1), ...(dapPath ? { path: dapPath } : {}) } : undefined;
			return { id: i + 1, name, ...(source ? { source } : {}), line: location?.line ?? 0, column: 1 };
		});
		this.respond(req, true, { stackFrames: frames.slice(start, start + levels), totalFrames: frames.length });
	}

	private newVariableRef(ref: VariableRef): number {
		const id = this.variableRefs.size + 1;
		this.variableRefs.set(id, ref);
		return id;
	}

	private scopes(req: Request, args: Args): void {
		const stop = this.requireStopped('list scopes');
		const frame = Number(args.frameId) - 1;
		if (!stop.lldbFrames[frame]) { throw new Error(`vscwClang: no frame ${args.frameId} in this stop's call stack; did the program run on since the stack was requested?`); }
		this.respond(req, true, { scopes: [{ name: 'Locals', variablesReference: this.newVariableRef({ frame, path: '' }), expensive: false }] });
	}

	private async variables(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const stop = this.requireStopped('list variables');
		const ref = this.variableRefs.get(Number(args.variablesReference));
		if (!ref) { throw new Error(`vscwClang: variablesReference ${args.variablesReference} is not from this stop; did the program run on since it was listed?`); }
		const rows = await evaluateWithMemory(this.memory, pages => this.fetchPages(pages), () => target.reactor.variables(ref.frame, ref.path), () => target.reactor.setStop(stop.lldbFrames));
		const variables = rows.map(row => ({
			name: row.name,
			// An aggregate with no formatter summary has no text of its own; its type tells more than a blank.
			value: row.value || `(${row.type})`,
			type: row.type,
			variablesReference: row.hasChildren ? this.newVariableRef({ frame: ref.frame, path: row.path }) : 0,
		}));
		this.respond(req, true, { variables });
	}

	private async evaluate(req: Request, args: Args): Promise<void> {
		const target = this.requireTarget();
		const stop = this.requireStopped('evaluate');
		const frame = args.frameId === undefined ? 0 : Number(args.frameId) - 1;
		const expression = String(args.expression ?? '').trim();
		// A lone variable path keeps lldb's type and children; anything else (`a + b`, `i == 3`) is computed here.
		const result = isPlainPath(expression)
			? await evaluateWithMemory(this.memory, pages => this.fetchPages(pages), () => target.reactor.formatValue(frame, expression), () => target.reactor.setStop(stop.lldbFrames))
			: String(await this.evaluateValue(expression, frame));
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
		// 'important' becomes a notification: in terminal mode the Debug Console is not opened, so stderr would go unseen.
		this.send({ type: 'event', event: 'output', body: { category: 'important', output: `vscwClang: ${message}\n` } });
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
