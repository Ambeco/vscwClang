import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { BreakpointIndex } from '../../debug/breakpointIndex';
import { DebugController, type DebugTarget } from '../../debug/debugController';
import type { DebuggeeEvent, DebuggeeSession, ResumeKind } from '../../debug/debuggeeSession';
import { parseLineTable } from '../../debug/dwarfLines';
import { workspacePathMapper, type PathMapper } from '../../debug/pathMapper';
import { ReactorHost } from '../../debug/reactorHost';
import { StubDebuggee } from '../../debug/stubDebuggee';
import { scanProgram } from '../../debug/wasmScan';
import { DapClient, type DapMessage } from './dapClient';
import { Debuggee } from './stubWorkerHarness';

const ROOT = process.cwd();
const REACTOR = join(ROOT, 'llvm-artifacts', 'bin', 'lldb-wasm-reactor.wasm');
const FIXTURES = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug');
// progstub.wasm / chattystub.wasm are prog.c / chatty.c with the debug stub linked in (commands in stubChannel.node.test.ts);
// their DWARF names the source file as a bare relative path, so the tests use an identity path mapper.
const PROG = join(FIXTURES, 'progstub.wasm');
const CHATTY = join(FIXTURES, 'chattystub.wasm');
const identity: PathMapper = { dapToGuest: p => p, guestToDap: p => p };

suite('dwarfLines and BreakpointIndex (real DWARF from prog.c)', () => {
	const bytes = new Uint8Array(readFileSync(PROG));
	const scan = scanProgram(bytes);
	const rows = parseLineTable(bytes, scan.module.customSections);
	const index = new BreakpointIndex(rows, scan.guardSites, scan.module);
	const guardsOf = (fn: string) => [...scan.guardSites].filter(([, s]) => scan.module.names.get(s.funcIndex) === fn).sort((a, b) => a[1].pc - b[1].pc).map(([g]) => g);

	test('parses the line table: prog.c lines and the linked libc files', () => {
		const lines = new Set(rows.filter(r => r.file === 'prog.c' && r.isStmt).map(r => r.line));
		for (const line of [3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19]) { assert.ok(lines.has(line), `line ${line} has code`); }
		assert.ok(rows.some(r => r.file.includes('crt1-command.c')));
		assert.ok(rows.every(r => r.addr > 0), 'rows of discarded (address 0) code are dropped');
	});

	test('a line that starts a block resolves to exactly that block', () => {
		assert.deepStrictEqual(index.resolve('prog.c', 3), { line: 3, guards: [guardsOf('add')[0]], stopsAtLine: undefined });
		assert.deepStrictEqual(index.resolve('prog.c', 10), { line: 10, guards: [guardsOf('caller')[0]], stopsAtLine: undefined });
	});

	test('a line in the middle of a block stops at the start of its block, and says where', () => {
		const r = index.resolve('prog.c', 12)!;
		assert.strictEqual(r.line, 12);
		assert.deepStrictEqual(r.guards, [guardsOf('caller')[0]]);
		assert.strictEqual(r.stopsAtLine, 10);
	});

	test('a line with no code moves to the next line that has some; past the end, or an unknown file, resolves to nothing', () => {
		assert.strictEqual(index.resolve('prog.c', 9)!.line, 10);
		assert.strictEqual(index.resolve('prog.c', 1)!.line, 3);
		assert.strictEqual(index.resolve('prog.c', 99), undefined);
		assert.strictEqual(index.resolve('other.c', 3), undefined);
	});

	test('lineAt maps a guard pc to its line, and is empty outside every sequence', () => {
		for (const [guard, site] of scan.guardSites) { assert.ok(index.lineAt(site.pc)?.line, `guard ${guard} has a line`); }
		assert.strictEqual(index.lineAt(1), undefined);
	});

	test('a program built without line info is rejected with a suggestion', () => {
		const plain = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
		assert.throws(() => parseLineTable(plain, new Map()), /no \.debug_line section; did you mean to build in debug mode/);
	});
});

suite('workspacePathMapper', () => {
	const file = workspacePathMapper({ uri: 'file:///home/me/proj', scheme: 'file', path: '/home/me/proj', fsPath: '/home/me/proj' });
	const web = workspacePathMapper({ uri: 'vscode-vfs://github/me/my%20repo', scheme: 'vscode-vfs', path: '/me/my repo', fsPath: '/me/my repo' });
	const windows = workspacePathMapper({ uri: 'file:///c%3A/Users/me/proj', scheme: 'file', path: '/c:/Users/me/proj', fsPath: 'c:\\Users\\me\\proj' });

	test('file folders map by fs path, both ways', () => {
		assert.strictEqual(file.dapToGuest('/home/me/proj/src/main.cpp'), '/workspace/src/main.cpp');
		assert.strictEqual(file.guestToDap('/workspace/src/main.cpp'), '/home/me/proj/src/main.cpp');
	});

	test('other schemes map by URI string, decoding and re-encoding path segments', () => {
		assert.strictEqual(web.dapToGuest('vscode-vfs://github/me/my%20repo/a%20b/c.cpp'), '/workspace/a b/c.cpp');
		assert.strictEqual(web.guestToDap('/workspace/a b/c.cpp'), 'vscode-vfs://github/me/my%20repo/a%20b/c.cpp');
	});

	test('Windows fs paths with backslashes map', () => {
		assert.strictEqual(windows.dapToGuest('c:\\Users\\me\\proj\\src\\main.cpp'), '/workspace/src/main.cpp');
	});

	test('paths outside the folder, and lookalike siblings, do not map', () => {
		assert.strictEqual(file.dapToGuest('/home/me/other/main.cpp'), undefined);
		assert.strictEqual(file.dapToGuest('/home/me/project2/main.cpp'), undefined);
		assert.strictEqual(file.guestToDap('/sysroot/include/stdio.h'), undefined);
	});
});

/** A client over a `DebugController` driven by a launch function. */
function makeClient(launch: (args: Record<string, unknown>) => Promise<DebugTarget>): DapClient & { controller: DebugController } {
	let controller: DebugController;
	const client = new DapClient(message => controller.handleMessage(message)) as DapClient & { controller: DebugController };
	controller = new DebugController({ launch, send: m => client.receive(m as DapMessage) });
	client.controller = controller;
	return client;
}

const suiteIfFixtures = existsSync(REACTOR) && existsSync(PROG) ? suite : suite.skip;

suiteIfFixtures('DebugController (real stub program, real lldb reactor, worker with a blocking stdin)', function () {
	this.timeout(120_000);
	const program = new Uint8Array(readFileSync(PROG));
	const scan = scanProgram(program);
	let reactor: ReactorHost;
	let dbg: Debuggee | undefined;
	let client: ReturnType<typeof makeClient>;

	suiteSetup(async () => {
		reactor = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		reactor.createTarget(program);
	});

	setup(() => {
		client = makeClient(async () => {
			const worker = new Debuggee(program);
			dbg = worker;
			const session = new StubDebuggee({ send: text => worker.write(text), exited: worker.exited, terminate: () => void worker.terminate(), guardSites: scan.guardSites });
			worker.onStderr = b => session.feedStderr(b);
			worker.onStdout = b => session.feedStdout(b);
			return { session, reactor, program, scan, paths: identity };
		});
	});
	teardown(async () => { await client.request('disconnect').catch(() => undefined); await dbg?.terminate(); dbg = undefined; });

	async function start(args: object = {}, breakpointLines: number[] = []): Promise<void> {
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', args);
		await client.event('initialized');
		if (breakpointLines.length) { await client.ok('setBreakpoints', { source: { path: 'prog.c' }, breakpoints: breakpointLines.map(line => ({ line })) }); }
		await client.ok('configurationDone');
	}

	const topFrames = async () => (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { id: number; name: string; line: number; source?: { name: string; path?: string } }[];
	const evaluate = async (expression: string, frameId = 1) => (await client.ok('evaluate', { expression, frameId, context: 'hover' })).result as string;

	test('with no breakpoints the program runs to its exit code, and the session ends', async () => {
		await start();
		assert.strictEqual((await client.event('exited')).body.exitCode, 11);
		await client.event('terminated');
	});

	test('initialize advertises what is implemented', async () => {
		const caps = await client.ok('initialize');
		assert.strictEqual(caps.supportsConfigurationDoneRequest, true);
		assert.strictEqual(caps.supportsEvaluateForHovers, true);
		assert.strictEqual(caps.supportsFunctionBreakpoints, undefined);
	});

	test('a breakpoint stops with the call stack, source lines and values', async () => {
		await start({}, [5]); // line 5 (`if (c > 100)`) starts add()'s second block, after a, b and c are set
		const stopped = await client.event('stopped');
		assert.strictEqual(stopped.body.reason, 'breakpoint');
		const frames = await topFrames();
		assert.deepStrictEqual(frames.map(f => f.name), ['add', 'caller', '__original_main']);
		assert.strictEqual(frames[0].line, 5);
		assert.strictEqual(frames[0].source?.name, 'prog.c');
		assert.match(frames[0].source?.path ?? '', /prog\.c$/);
		assert.match(await evaluate('a'), /\(int\) a = 1\b/);
		assert.match(await evaluate('b'), /\(int\) b = 10\b/);
		assert.match(await evaluate('x', 2), /\(int\) x = 1\b/);
		assert.deepStrictEqual((await client.ok('threads')).threads, [{ id: 1, name: 'main' }]);
		const scopes = (await client.ok('scopes', { frameId: 1 })).scopes;
		assert.strictEqual(scopes[0].name, 'Locals');
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 11);
	});

	test('a line in the middle of a block is accepted, and the response says where it will really stop', async () => {
		await client.ok('initialize');
		await client.ok('launch', {});
		await client.event('initialized');
		const body = await client.ok('setBreakpoints', { source: { path: 'prog.c' }, breakpoints: [{ line: 12 }, { line: 9 }, { line: 99 }] });
		assert.deepStrictEqual(body.breakpoints.map((b: any) => [b.verified, b.line]), [[true, 12], [true, 10], [false, 99]]);
		assert.match(body.breakpoints[0].message, /block containing this line starts \(line 10\)/);
		assert.match(body.breakpoints[2].message, /no code at or after line 99/);
	});

	test('a source outside the workspace is unverified with a reason, not an error', async () => {
		const mapped = makeClient(async () => {
			const worker = new Debuggee(program);
			dbg = worker;
			const session = new StubDebuggee({ send: t => worker.write(t), exited: worker.exited, terminate: () => void worker.terminate(), guardSites: scan.guardSites });
			worker.onStderr = b => session.feedStderr(b);
			return { session, reactor, program, scan, paths: workspacePathMapper({ uri: 'file:///proj', scheme: 'file', path: '/proj', fsPath: '/proj' }) };
		});
		await mapped.ok('initialize'); await mapped.ok('launch', {}); await mapped.event('initialized');
		const body = await mapped.ok('setBreakpoints', { source: { path: '/elsewhere/prog.c' }, breakpoints: [{ line: 3 }] });
		assert.strictEqual(body.breakpoints[0].verified, false);
		assert.match(body.breakpoints[0].message, /outside the workspace folder/);
	});

	test('step over moves to the next block in the same function; step out returns to the caller; step in enters the callee', async () => {
		await start({}, [10]);
		await client.event('stopped');
		assert.deepStrictEqual((await topFrames()).map(f => f.name), ['caller', '__original_main']);

		await client.ok('stepIn', { threadId: 1 }); // caller's entry block calls add(): stepping in enters it
		await client.event('stopped');
		let frames = await topFrames();
		for (let i = 0; i < 6 && frames[0].name !== 'add'; i++) {
			await client.ok('stepIn', { threadId: 1 });
			await client.event('stopped');
			frames = await topFrames();
		}
		assert.deepStrictEqual(frames.map(f => f.name), ['add', 'caller', '__original_main']);
		assert.strictEqual(client.events('stopped').at(-1)!.body.reason, 'step');

		await client.ok('next', { threadId: 1 });
		await client.event('stopped');
		frames = await topFrames();
		assert.strictEqual(frames[0].name, 'add', 'step over stays in add');
		assert.match(await evaluate('c'), /\(int\) c = 11\b/);

		await client.ok('stepOut', { threadId: 1 });
		await client.event('stopped');
		frames = await topFrames();
		assert.deepStrictEqual(frames.map(f => f.name), ['caller', '__original_main']);

		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 11);
	});

	test('stopOnEntry stops in main before any of its code runs', async () => {
		await start({ stopOnEntry: true });
		assert.strictEqual((await client.event('stopped')).body.reason, 'entry');
		assert.strictEqual((await topFrames())[0].name, '__original_main');
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 11);
	});

	test('breakpoints moved at a stop take effect on the next resume', async () => {
		await start({}, [3]);
		await client.event('stopped');
		await client.ok('setBreakpoints', { source: { path: 'prog.c' }, breakpoints: [{ line: 13 }] });
		await client.ok('continue', { threadId: 1 });
		await client.event('stopped');
		assert.strictEqual((await topFrames())[0].name, 'caller');
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 11);
	});

	test('requests that need a stop fail clearly while the program runs or after it exited; pause says why it cannot work', async () => {
		await start();
		await client.event('exited');
		const afterExit = await client.request('stackTrace', { threadId: 1 });
		assert.strictEqual(afterExit.success, false);
		assert.match(afterExit.message!, /the program has exited/);
		const pause = await client.request('pause', { threadId: 1 });
		assert.strictEqual(pause.success, false);
		assert.match(pause.message!, /cannot pause a program that is running/);
		const unknown = await client.request('stepBack');
		assert.match(unknown.message!, /'stepBack' is not implemented\. Did you mean one of/);
	});

	test('evaluating a name that does not exist fails with lldb\'s message', async () => {
		await start({}, [3]);
		await client.event('stopped');
		const r = await client.request('evaluate', { expression: 'no_such_variable', frameId: 1 });
		assert.strictEqual(r.success, false);
		assert.match(r.message!, /lldb could not evaluate "no_such_variable"/);
	});

	test('terminate ends the session with a terminated event', async () => {
		await start({}, [3]);
		await client.event('stopped');
		await client.ok('terminate');
		await client.event('terminated');
	});
});

const suiteIfChatty = existsSync(REACTOR) && existsSync(CHATTY) ? suite : suite.skip;

suiteIfChatty('DebugController program output (chatty.c: prompt, scanf, stderr, stdout)', function () {
	this.timeout(60_000);
	test('stdout and stderr of the program arrive as output events, byte-exact around the stub frames', async () => {
		const program = new Uint8Array(readFileSync(CHATTY));
		const scan = scanProgram(program);
		const reactor = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		reactor.createTarget(program);
		let worker: Debuggee | undefined;
		const client = makeClient(async () => {
			worker = new Debuggee(program);
			const w = worker;
			const session = new StubDebuggee({ send: t => w.write(t), exited: w.exited, terminate: () => void w.terminate(), guardSites: scan.guardSites });
			w.onStderr = b => session.feedStderr(b);
			w.onStdout = b => session.feedStdout(b);
			return { session, reactor, program, scan, paths: identity };
		});
		try {
			await client.ok('initialize'); await client.ok('launch', {}); await client.event('initialized');
			await client.ok('configurationDone');
			worker!.write('7\n'); // the program is running, so this is its stdin
			assert.strictEqual((await client.event('exited')).body.exitCode, 49);
			const out = (category: string) => client.events('output').filter(m => m.body.category === category).map(m => m.body.output).join('');
			assert.strictEqual(out('stdout'), 'enter: result 49\n');
			assert.strictEqual(out('stderr'), 'got 7\nin square\n');
		} finally { await worker?.terminate(); }
	});
});

/** A scripted host: the tests decide when it stops, so controller behavior that depends on timing is deterministic. */
class FakeSession implements DebuggeeSession {
	capabilities = { pause: false, breakpointsWhileRunning: false };
	listener: ((e: DebuggeeEvent) => void) | undefined;
	armed: number[][] = [];
	resumed: ResumeKind[] = [];
	async start(): Promise<void> { this.listener!({ kind: 'stopped', reason: 'start', frames: [] }); }
	async setBreakpoints(guards: number[]): Promise<void> { this.armed.push(guards); }
	async resume(how: ResumeKind): Promise<void> { this.resumed.push(how); }
	async pause(): Promise<void> { throw new Error('no pause'); }
	async readMemory(): Promise<Uint8Array | undefined> { return new Uint8Array(4096); }
	async terminate(): Promise<void> { /* nothing to stop */ }
}

suiteIfFixtures('DebugController with a scripted host', function () {
	this.timeout(60_000);
	test('breakpoints set while the program runs are queued, and armed at the next stop before it is reported', async () => {
		const program = new Uint8Array(readFileSync(PROG));
		const scan = scanProgram(program);
		const reactor = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		reactor.createTarget(program);
		const fake = new FakeSession();
		const client = makeClient(async () => ({ session: fake, reactor, program, scan, paths: identity }));
		await client.ok('initialize'); await client.ok('launch', {}); await client.event('initialized');
		await client.ok('configurationDone');
		assert.deepStrictEqual(fake.resumed, ['continue']);

		const body = await client.ok('setBreakpoints', { source: { path: 'prog.c' }, breakpoints: [{ line: 3 }] });
		assert.strictEqual(body.breakpoints[0].verified, true);
		assert.deepStrictEqual(fake.armed, [], 'the host cannot take breakpoints while running');

		const add = [...scan.guardSites].filter(([, s]) => scan.module.names.get(s.funcIndex) === 'add').sort((a, b) => a[1].pc - b[1].pc)[0];
		fake.listener!({ kind: 'stopped', reason: 'pause', frames: [{ funcIndex: add[1].funcIndex, pc: add[1].pc, sp: 1000 }] });
		await client.event('stopped');
		assert.deepStrictEqual(fake.armed, [[add[0]]]);
	});
});
