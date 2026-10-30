import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { artifactReactor } from '../artifacts';
import { DebugController, type DebugTarget } from '../../debug/debugController';
import { evaluateExpression, formatLogMessage, hitConditionMatches, isPlainPath, scalarFromFormatted } from '../../debug/debugExpression';
import { demangle, displayFunctionName, functionNameMatches } from '../../debug/demangle';
import type { PathMapper } from '../../debug/pathMapper';
import { ReactorHost } from '../../debug/reactorHost';
import { StubDebuggee } from '../../debug/stubDebuggee';
import { scanProgram } from '../../debug/wasmScan';
import { DapClient, type DapMessage } from './dapClient';
import { Debuggee } from './stubWorkerHarness';

suite('evaluateExpression', () => {
	const vars: Record<string, number | boolean> = { i: 3, n: 10, p: 0, 'q.x': 7, 'a[2]': 5, flag: true };
	const ev = (src: string) => evaluateExpression(src, path => {
		if (!(path in vars)) { throw new Error(`no ${path}`); }
		return vars[path];
	});

	test('arithmetic follows C precedence, with truncating integer division', () => {
		assert.strictEqual(ev('1 + 2 * 3'), 7);
		assert.strictEqual(ev('(1 + 2) * 3'), 9);
		assert.strictEqual(ev('-7 / 2'), -3);
		assert.strictEqual(ev('7 % 4'), 3);
		assert.strictEqual(ev('1.5 * 2'), 3);
		assert.strictEqual(ev('0x10 + 1'), 17);
	});

	test('comparisons and logic read variable paths', () => {
		assert.strictEqual(ev('i == 3'), true);
		assert.strictEqual(ev('i != 3'), false);
		assert.strictEqual(ev('i < n && q.x >= 7'), true);
		assert.strictEqual(ev('a[2] > 5 || i <= 3'), true);
		assert.strictEqual(ev('!flag'), false);
		assert.strictEqual(ev('flag == true'), true);
		assert.strictEqual(ev('q . x == 7'), true);
	});

	test('&& and || short-circuit, so a guarded read never happens', () => {
		const reads: string[] = [];
		const r = evaluateExpression('p != 0 && missing > 1', path => { reads.push(path); return path === 'p' ? 0 : 1; });
		assert.strictEqual(r, false);
		assert.deepStrictEqual(reads, ['p']);
		assert.strictEqual(evaluateExpression('1 || 1 / 0', () => 0), true);
	});

	test('errors say what is unsupported and suggest a fix', () => {
		assert.throws(() => evaluateExpression('f(1)', () => 0), /unexpected "\(" after the expression/);
		assert.throws(() => ev('*p'), /did you mean to compare a member/);
		assert.throws(() => ev('"abc"'), /unsupported text/);
		assert.throws(() => ev('(1 + 2'), /a "\)" is missing/);
		assert.throws(() => ev('1 +'), /ends early/);
		assert.throws(() => ev('1 / 0'), /division by zero/);
		assert.throws(() => ev('nope > 1'), /no nope/);
		assert.throws(() => ev('1 2'), /after the expression/);
	});

	test('isPlainPath only accepts a lone variable path', () => {
		for (const ok of ['x', ' p.y ', 'q->z', 'arr[2]', 'a.b[1].c']) { assert.ok(isPlainPath(ok), ok); }
		for (const no of ['x + 1', 'a == b', '3', 'true', '!x', '']) { assert.ok(!isPlainPath(no), no); }
	});
});

suite('scalarFromFormatted, hitConditionMatches, formatLogMessage', () => {
	test('reads lldb\'s formatted scalars', () => {
		assert.strictEqual(scalarFromFormatted('a', '(int) a = 42'), 42);
		assert.strictEqual(scalarFromFormatted('c', "(char) c = 97 'a'"), 97);
		assert.strictEqual(scalarFromFormatted('d', '(double) d = -1.5'), -1.5);
		assert.strictEqual(scalarFromFormatted('p', '(int *) p = 0x00000000'), 0);
		assert.strictEqual(scalarFromFormatted('b', '(bool) b = true'), true);
		assert.throws(() => scalarFromFormatted('s', '(P) s = {x = 1, y = 2}'), /"s" is not a number, bool or pointer/);
	});

	test('hit conditions', () => {
		assert.ok(hitConditionMatches('3', 3) && !hitConditionMatches('3', 4));
		assert.ok(hitConditionMatches('== 2', 2));
		assert.ok(hitConditionMatches('>= 2', 5) && !hitConditionMatches('> 2', 2));
		assert.ok(hitConditionMatches('< 3', 2) && hitConditionMatches('<= 3', 3));
		assert.ok(hitConditionMatches('% 2', 4) && !hitConditionMatches('% 2', 3));
		assert.throws(() => hitConditionMatches('often', 1), /did you mean a number such as 5/);
	});

	test('log messages fill {expressions} and keep escaped braces', () => {
		assert.strictEqual(formatLogMessage('i={i}, sum={ i + 1 } \\{x\\}', e => `<${e}>`), 'i=<i>, sum=<i + 1> {x}');
	});
});

suite('demangle', () => {
	test('plain, internal-linkage, nested and operator names', () => {
		assert.strictEqual(demangle('_ZL3addii'), 'add(int, int)');
		assert.strictEqual(demangle('_Z4mainv'), 'main()');
		assert.strictEqual(demangle('_ZN2ns3fooEPKc'), 'ns::foo(char const*)');
		assert.strictEqual(demangle('_ZN3Foo3barEv'), 'Foo::bar()');
		assert.strictEqual(demangle('_ZNK3Foo3getEv'), 'Foo::get() const');
		assert.strictEqual(demangle('_ZN3FooC2Ei'), 'Foo::Foo(int)');
		assert.strictEqual(demangle('_ZN3FooD2Ev'), 'Foo::~Foo()');
		assert.strictEqual(demangle('_ZN3FoopLEi'), 'Foo::operator+=(int)');
		assert.strictEqual(demangle('_Z3sumRKN2ns1PEd'), 'sum(ns::P const&, double)');
	});

	test('names it cannot decode, and C names, come back unchanged', () => {
		for (const name of ['_ZNSt3__16vectorIiE9push_backEOi', '_ZSt4moveIiEOT_RS0_', 'add', '__original_main', 'memcpy']) {
			assert.strictEqual(demangle(name), name);
		}
		assert.strictEqual(demangle('_ZN3Foo3barE'), 'Foo::bar');
	});

	test('stack frames show main for the compiler\'s __original_main', () => {
		assert.strictEqual(displayFunctionName('__original_main'), 'main');
		assert.strictEqual(displayFunctionName('_ZL3addii'), 'add(int, int)');
		assert.strictEqual(displayFunctionName('caller'), 'caller');
	});

	test('function breakpoint names match bare, qualified and full forms', () => {
		assert.ok(functionNameMatches('_ZL3addii', 'add') && functionNameMatches('_ZL3addii', 'add(int, int)'));
		assert.ok(functionNameMatches('_ZN2ns3fooEPKc', 'foo') && functionNameMatches('_ZN2ns3fooEPKc', 'ns::foo'));
		assert.ok(!functionNameMatches('_ZN2ns3fooEPKc', 'oo') && !functionNameMatches('_ZL3addii', 'add(long)'));
		assert.ok(functionNameMatches('caller', 'caller') && functionNameMatches('__original_main', 'main'));
	});
});

const ROOT = process.cwd();
const REACTOR = artifactReactor();
const LOOP = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'loopstub.wasm');
const identity: PathMapper = { dapToGuest: p => p, guestToDap: p => p };
const suiteIfFixtures = existsSync(REACTOR) && existsSync(LOOP) ? suite : suite.skip;

// loop.c: line 1 `int square(int n)`, 2 `return n * n;`, 8 `total += square(i);` (runs for i = 0..5), exit code 55.
suiteIfFixtures('DebugController conditional breakpoints, hit counts, logpoints and function breakpoints (loop.c)', function () {
	this.timeout(120_000);
	const program = new Uint8Array(readFileSync(LOOP));
	const scan = scanProgram(program);
	let reactor: ReactorHost;
	let dbg: Debuggee | undefined;
	let client: DapClient;

	suiteSetup(async () => {
		reactor = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		reactor.createTarget(program);
	});

	setup(() => {
		let controller: DebugController;
		client = new DapClient(message => controller.handleMessage(message));
		controller = new DebugController({
			send: m => client.receive(m as DapMessage),
			launch: async (): Promise<DebugTarget> => {
				const worker = new Debuggee(program);
				dbg = worker;
				const session = new StubDebuggee({ send: text => worker.write(text), exited: worker.exited, terminate: () => void worker.terminate(), guardSites: scan.guardSites });
				worker.onStderr = b => session.feedStderr(b);
				worker.onStdout = b => session.feedStdout(b);
				return { session, reactor, program, scan, paths: identity };
			},
		});
	});
	teardown(async () => { await client.request('disconnect').catch(() => undefined); await dbg?.terminate(); dbg = undefined; });

	async function start(breakpoint: Record<string, unknown> | undefined, functions: { name: string; condition?: string; hitCondition?: string }[] = []): Promise<any> {
		await client.ok('initialize', {});
		await client.ok('launch', {});
		await client.event('initialized');
		let body: any;
		if (breakpoint) { body = await client.ok('setBreakpoints', { source: { path: 'loop.c' }, breakpoints: [breakpoint] }); }
		if (functions.length) { body = await client.ok('setFunctionBreakpoints', { breakpoints: functions }); }
		await client.ok('configurationDone');
		return body;
	}
	const evaluate = async (expression: string) => (await client.ok('evaluate', { expression, frameId: 1, context: 'watch' })).result as string;
	const topFrame = async () => (await client.ok('stackTrace', { threadId: 1 })).stackFrames[0] as { name: string; line: number };
	const iValue = async () => Number(/= (\d+)/.exec(await evaluate('i'))![1]);
	const finish = async () => { await client.ok('continue', { threadId: 1 }); assert.strictEqual((await client.event('exited')).body.exitCode, 55); };

	test('a condition stops only when it holds, and a later continue stops again when it next holds', async () => {
		await start({ line: 8, condition: 'i >= 2 && i % 2 == 0' });
		await client.event('stopped');
		assert.strictEqual(await iValue(), 2);
		await client.ok('continue', { threadId: 1 });
		await client.event('stopped');
		assert.strictEqual(await iValue(), 4);
		await finish();
		assert.strictEqual(client.events('stopped').length, 2);
	});

	test('a condition that is never true lets the program run to its exit', async () => {
		await start({ line: 8, condition: 'i > 100' });
		assert.strictEqual((await client.event('exited')).body.exitCode, 55);
		assert.strictEqual(client.events('stopped').length, 0);
	});

	test('a hit count stops on the Nth hit, and `% N` on every Nth', async () => {
		await start({ line: 8, hitCondition: '4' });
		await client.event('stopped');
		assert.strictEqual(await iValue(), 3);
		await finish();
		assert.strictEqual(client.events('stopped').length, 1);
	});

	test('hit counts count only hits whose condition held', async () => {
		await start({ line: 8, condition: 'i % 2 == 1', hitCondition: '2' });
		await client.event('stopped');
		assert.strictEqual(await iValue(), 3); // hits at i = 1, 3, 5: the second
		await finish();
	});

	test('a broken condition stops, and says why', async () => {
		await start({ line: 8, condition: 'nope > 1' });
		await client.event('stopped');
		const note = client.events('output').find(m => m.body.category === 'important');
		assert.match(note!.body.output, /breakpoint condition "nope > 1" failed, so the program stopped/);
		await client.ok('continue', { threadId: 1 });
		await client.event('stopped'); // it stops on every hit until the condition is fixed
	});

	test('a logpoint prints its message with values and does not stop', async () => {
		await start({ line: 8, logMessage: 'i={i} next={i + 1}' });
		assert.strictEqual((await client.event('exited')).body.exitCode, 55);
		const lines = client.events('output').filter(m => m.body.category === 'console').map(m => m.body.output);
		assert.deepStrictEqual(lines, [0, 1, 2, 3, 4, 5].map(i => `i=${i} next=${i + 1}\n`));
		assert.strictEqual(client.events('stopped').length, 0);
	});

	test('a function breakpoint stops in the function, after its parameters are stored, and honors a condition', async () => {
		const body = await start(undefined, [{ name: 'square', condition: 'n == 3' }]);
		assert.strictEqual(body.breakpoints[0].verified, true);
		await client.event('stopped');
		const frame = await topFrame();
		assert.deepStrictEqual([frame.name, frame.line], ['square', 2]);
		assert.match(await evaluate('n'), /= 3\b/);
		assert.match(await evaluate('n * n + 1'), /^10$/);
		await finish();
	});

	test('an unknown function breakpoint is unverified with a suggestion', async () => {
		const body = await start(undefined, [{ name: 'nosuch' }]);
		assert.strictEqual(body.breakpoints[0].verified, false);
		assert.match(body.breakpoints[0].message, /no function named "nosuch" has code in this program; did you mean/);
		assert.strictEqual((await client.event('exited')).body.exitCode, 55);
	});

	test('main is named main in the call stack', async () => {
		await start({ line: 2 });
		await client.event('stopped');
		const frames = (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { name: string }[];
		assert.deepStrictEqual(frames.map(f => f.name), ['square', 'main']);
		await client.ok('disconnect');
	});
});
