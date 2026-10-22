import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ReactorHost } from '../../debug/reactorHost';
import { evaluateWithMemory, PAGE_SIZE, PagedMemory } from '../../debug/pagedMemory';
import { FrameDemux, parseMessage, StubSession, type StubMessage } from '../../debug/stubChannel';
import { scanProgram } from '../../debug/wasmScan';
import { Debuggee } from './stubWorkerHarness';

const ROOT = process.cwd();
const REACTOR = join(ROOT, 'llvm-artifacts', 'bin', 'lldb-wasm-reactor.wasm');
// progstub.wasm is fixtures/debug/prog.c plus src/web/debug/debugStub.c (wasi-sdk 34):
//   clang -O2 -c debugStub.c -o debugStub.o
//   clang -O0 -g -fsanitize-coverage=trace-pc-guard prog.c debugStub.o -Wl,--export=__sanitizer_cov_trace_pc_guard -o progstub.wasm
// `node scripts/build-debug-fixtures.mjs` rebuilds both stub fixtures with llvm-artifacts' own clang/lld; rerun it after editing debugStub.c.
const PROG = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'progstub.wasm');
const ESC = String.fromCharCode(27);
const frame = (text: string) => `${ESC}_vscw ${text}${ESC}\\`;
const bytes = (s: string) => new TextEncoder().encode(s);

suite('stubChannel: FrameDemux', () => {
	function demux(): { d: FrameDemux; messages: StubMessage[]; program: () => string } {
		const messages: StubMessage[] = [];
		let program = '';
		const d = new FrameDemux(m => messages.push(m), b => { program += new TextDecoder().decode(b); });
		return { d, messages, program: () => program };
	}

	test('passes program stderr through and extracts frames', () => {
		const { d, messages, program } = demux();
		d.push(bytes(`before ${frame('hello 100 200')} after`));
		d.end();
		assert.strictEqual(program(), 'before  after');
		assert.deepStrictEqual(messages, [{ kind: 'hello', guardStart: 100, guardEnd: 200 }]);
	});

	test('a frame split across chunks at every byte boundary still parses, and program bytes keep their order', () => {
		const whole = bytes(`abc${frame('stop breakpoint 2 10 5000 20 6000')}def`);
		for (let cut = 1; cut < whole.length; cut++) {
			const { d, messages, program } = demux();
			d.push(whole.subarray(0, cut)); d.push(whole.subarray(cut)); d.end();
			assert.strictEqual(program(), 'abcdef', `cut at ${cut}`);
			assert.deepStrictEqual(messages, [{ kind: 'stop', reason: 'breakpoint', frames: [{ guard: 10, sp: 5000 }, { guard: 20, sp: 6000 }] }], `cut at ${cut}`);
		}
	});

	test('an escape sequence that is not ours (program ANSI colour) passes through untouched', () => {
		const { d, messages, program } = demux();
		d.push(bytes(`${ESC}[31mred${ESC}[0m${ESC}_other`));
		d.end();
		assert.strictEqual(program(), `${ESC}[31mred${ESC}[0m${ESC}_other`);
		assert.strictEqual(messages.length, 0);
	});

	test('several frames in one chunk, and an unknown message kind throws with a hint', () => {
		const { d, messages } = demux();
		d.push(bytes(frame('error one') + frame('memerr 4096 8192')));
		assert.deepStrictEqual(messages, [{ kind: 'error', text: 'one' }, { kind: 'memerr', addr: 4096, len: 8192 }]);
		assert.throws(() => parseMessage('wat 1'), /unknown kind "wat".*drift/);
	});

	test('mem frames decode hex', () => {
		assert.deepStrictEqual(parseMessage('mem 4096 00ff10'), { kind: 'mem', addr: 4096, data: new Uint8Array([0, 255, 16]) });
	});
});

suite('stubChannel: PagedMemory and evaluateWithMemory', () => {
	test('a read of an uncached page records the miss and returns nothing; cached pages serve exactly the bytes asked', () => {
		const m = new PagedMemory();
		assert.strictEqual(m.read(PAGE_SIZE + 4, 8).length, 0);
		assert.deepStrictEqual([...m.misses], [1]);
		const page = new Uint8Array(PAGE_SIZE).map((_, i) => i & 255);
		m.set(1, page);
		m.misses.clear();
		assert.deepStrictEqual([...m.read(PAGE_SIZE + 4, 4)], [4, 5, 6, 7]);
		assert.strictEqual(m.misses.size, 0);
	});

	test('a read spanning two pages needs both', () => {
		const m = new PagedMemory();
		m.set(0, new Uint8Array(PAGE_SIZE).fill(1));
		assert.strictEqual(m.read(PAGE_SIZE - 2, 4).length, 0);
		assert.deepStrictEqual([...m.misses], [1]);
		m.set(1, new Uint8Array(PAGE_SIZE).fill(2));
		assert.deepStrictEqual([...m.read(PAGE_SIZE - 2, 4)], [1, 1, 2, 2]);
	});

	test('evaluateWithMemory fetches missed pages and re-runs, discarding errors from the incomplete attempt', async () => {
		const m = new PagedMemory();
		const fetched: number[][] = [];
		let calls = 0;
		const result = await evaluateWithMemory(m, async pages => { fetched.push(pages); pages.forEach(p => m.set(p, new Uint8Array(PAGE_SIZE).fill(7))); }, () => {
			calls++;
			const got = m.read(3 * PAGE_SIZE, 1);
			if (got.length === 0) { throw new Error('lldb could not read memory'); }
			return got[0];
		});
		assert.strictEqual(result, 7);
		assert.deepStrictEqual(fetched, [[3]]);
		assert.strictEqual(calls, 2);
	});

	test('a genuine error with no missed pages is rethrown, and an unreadable page ends the retries', async () => {
		const m = new PagedMemory();
		await assert.rejects(evaluateWithMemory(m, async () => undefined, () => { throw new Error('no such variable'); }), /no such variable/);
		let rounds = 0;
		await assert.rejects(evaluateWithMemory(m, async pages => { rounds++; pages.forEach(p => m.set(p, null)); }, () => {
			if (m.read(0, 4).length === 0) { throw new Error('unreadable'); }
			return 1;
		}), /unreadable/);
		assert.strictEqual(rounds, 1);
	});
});

const suiteIfFixtures = existsSync(REACTOR) && existsSync(PROG) ? suite : suite.skip;

suiteIfFixtures('stub + real program + real lldb reactor (worker with a blocking stdin)', function () {
	this.timeout(120000);
	const wasm = new Uint8Array(readFileSync(PROG));
	const scan = scanProgram(wasm);
	const nameOf = (funcIndex: number) => scan.module.names.get(funcIndex);
	let host: ReactorHost;
	let dbg: Debuggee | undefined;
	let session: StubSession;
	let programStderr: string;
	let commandsSent: string[];

	suiteSetup(async () => {
		host = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		host.createTarget(wasm);
	});

	setup(() => {
		programStderr = '';
		commandsSent = [];
		dbg = new Debuggee(wasm);
		session = new StubSession(text => { commandsSent.push(text.trim()); dbg!.write(text); }, b => { programStderr += new TextDecoder().decode(b); });
		dbg.onStderr = b => session.onStderr(b);
	});

	teardown(async () => { await dbg?.terminate(); dbg = undefined; });

	const guardsOf = (fn: string) => [...scan.guardSites].filter(([, s]) => nameOf(s.funcIndex) === fn).sort((a, b) => a[1].pc - b[1].pc).map(([g]) => g);

	async function stopFrames(stop: { frames: { guard: number; sp: number }[] }) {
		const frames = stop.frames.map(f => {
			const site = scan.guardSites.get(f.guard)!;
			return { funcIndex: site.funcIndex, pc: site.pc, sp: f.sp, frameBaseLocal: scan.frameBaseLocals.get(site.funcIndex)! };
		});
		host.setMemory({ read: session.memory.read });
		host.setStop(frames);
		resetStop = () => host.setStop(frames);
		return frames;
	}
	let resetStop: () => void;
	const evaluate = <T>(op: () => T) => session.evaluate(op, resetStop);

	test('the program waits at startup for the host, then runs to its exit code once released', async () => {
		const start = await session.nextStop();
		assert.strictEqual(start.reason, 'start');
		assert.ok(session.guardRange && session.guardRange.end > session.guardRange.start, JSON.stringify(session.guardRange));
		assert.strictEqual(dbg!.exitCode, undefined, 'must not have run ahead of the handshake');
		await session.resume('go');
		assert.strictEqual(await dbg!.exited, 11);
		assert.strictEqual(programStderr, '');
	});

	test('a breakpoint stop reports the call stack, and lldb decodes values through fetched pages', async () => {
		await session.nextStop();
		const addSecondBlock = guardsOf('add')[1];
		await session.setBreakpoints([addSecondBlock]);
		await session.resume('go');
		const stop = await session.nextStop();
		assert.strictEqual(stop.reason, 'breakpoint');
		const frames = await stopFrames(stop);
		assert.deepStrictEqual(frames.map(f => nameOf(f.funcIndex)), ['add', 'caller', '__original_main']);
		const bt = await evaluate(() => host.backtrace());
		assert.strictEqual(bt.length, 3, bt.join('\n'));
		assert.match(bt[0], /prog\.c:\d+/);
		const [a, b, c, p] = [await evaluate(() => host.formatValue(0, 'a')), await evaluate(() => host.formatValue(0, 'b')),
			await evaluate(() => host.formatValue(0, 'c')), await evaluate(() => host.formatValue(1, 'p'))];
		assert.match(a, /\(int\) a = 1\b/);
		assert.match(b, /\(int\) b = 10\b/);
		assert.match(c, /\(int\) c = 11\b/);
		assert.match(p, /x = 1[^]*y = 2/);
		const memFetches = commandsSent.filter(c => c.startsWith('vscw mem')).length;
		console.log(`      (${memFetches} page fetches for 4 values and a backtrace)`);
		assert.ok(memFetches >= 1 && memFetches <= 6, `page fetches: ${memFetches}`);
		await session.resume('go');
		assert.strictEqual(await dbg!.exited, 11);
	});

	test('step out returns to the caller; step over never enters a callee; into enters it', async () => {
		await session.nextStop();
		await session.setBreakpoints([guardsOf('caller')[0]]);
		await session.resume('go');
		let stop = await session.nextStop();
		let frames = await stopFrames(stop);
		assert.deepStrictEqual(frames.map(f => nameOf(f.funcIndex)), ['caller', '__original_main']);

		await session.resume('over'); // caller calls add(): over must not stop inside it
		stop = await session.nextStop();
		frames = await stopFrames(stop);
		assert.strictEqual(stop.reason, 'step');
		assert.strictEqual(nameOf(frames[0].funcIndex), 'caller', 'stepped over add()');
		assert.strictEqual(frames.length, 2);

		await session.setBreakpoints([]);
		await session.resume('out'); // leaves caller back to main; main has no further blocks, so the program just exits
		assert.strictEqual(await dbg!.exited, 11);
	});

	test('step into enters the callee', async () => {
		await session.nextStop();
		await session.setBreakpoints([guardsOf('caller')[0]]);
		await session.resume('go');
		await session.nextStop();
		await session.resume('into');
		let stop = await session.nextStop();
		let frames = await stopFrames(stop);
		// Blocks of caller come first (the call is in the same block); keep stepping until add() is entered.
		for (let i = 0; i < 10 && nameOf(frames[0].funcIndex) !== 'add'; i++) {
			await session.resume('into');
			stop = await session.nextStop();
			frames = await stopFrames(stop);
		}
		assert.deepStrictEqual(frames.map(f => nameOf(f.funcIndex)), ['add', 'caller', '__original_main']);
		await session.setBreakpoints([]);
		await session.resume('go');
		assert.strictEqual(await dbg!.exited, 11);
	});

	test('a memory read past the end of memory is reported as unreadable, not a trap', async () => {
		await session.nextStop();
		await session.fetchPages([0x7ffff]); // far beyond the program's memory
		assert.strictEqual(session.memory.read(0x7ffff * PAGE_SIZE, 4).length, 0);
		assert.strictEqual(session.memory.misses.size, 0, 'an unreadable page is final, not a miss to retry');
		await session.resume('go');
		assert.strictEqual(await dbg!.exited, 11);
	});
});

const CHATTY = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'chattystub.wasm');
const suiteIfChatty = existsSync(CHATTY) ? suite : suite.skip;

// chatty.c prints a prompt, reads an int with scanf, writes to stderr before and inside square(), prints the result.
suiteIfChatty('stub sharing stdio with a program that uses stdout, stderr and stdin itself', function () {
	this.timeout(60000);
	const wasm = new Uint8Array(readFileSync(CHATTY));
	const scan = scanProgram(wasm);
	let dbg: Debuggee;
	let session: StubSession;
	let programStderr: string;

	setup(() => {
		programStderr = '';
		dbg = new Debuggee(wasm);
		session = new StubSession(text => dbg.write(text), b => { programStderr += new TextDecoder().decode(b); });
		dbg.onStderr = b => session.onStderr(b);
	});
	teardown(async () => { await dbg.terminate(); });

	test('program input typed while it runs reaches scanf, not the stub; stderr text is byte-exact around the frames', async () => {
		await session.nextStop();
		const square = [...scan.guardSites].find(([, s]) => scan.module.names.get(s.funcIndex) === 'square')![0];
		await session.setBreakpoints([square]);
		await session.resume('go');
		dbg.write('7\n'); // the program is running (blocked in scanf), so this is its input
		const stop = await session.nextStop();
		assert.strictEqual(stop.reason, 'breakpoint');
		assert.strictEqual(stop.frames.length, 2);
		assert.strictEqual(programStderr, 'got 7\n', 'stderr before the stop arrives intact, with no frame bytes in it');
		await session.fetchPages([Math.floor(stop.frames[0].sp / PAGE_SIZE)]);
		await session.resume('go');
		assert.strictEqual(await dbg.exited, 49);
		session.endStderr();
		assert.strictEqual(programStderr, 'got 7\nin square\n');
		assert.strictEqual(dbg.stdout, 'enter: result 49\n');
	});

	test('with no breakpoints the program just runs to completion after the handshake', async () => {
		await session.nextStop();
		await session.resume('go');
		dbg.write('3\n');
		assert.strictEqual(await dbg.exited, 9);
		assert.strictEqual(dbg.stdout, 'enter: result 9\n');
	});
});
