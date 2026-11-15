import * as assert from 'assert';
import type { DebuggeeFrame } from '../../debug/debuggeeSession';
import type { StubThread } from '../../debug/stubRegistry';
import { pickTrappedThread, refineFrames } from '../../debug/trapStop';
import { startProgram, until } from './threadedProgramHarness';

suite('traps as stopped states (real stub, shared memory)', function () {
	this.timeout(60_000);

	async function runToTrap(mode: string) {
		const p = startProgram('trap', true, [mode]);
		assert.strictEqual((await p.nextStop()).reason, 'start');
		await p.debuggee.resume('continue');
		return { p, trap: await p.nextStop() };
	}

	test('__builtin_trap in main stops as an exception on the main thread with the call stack and the engine message', async () => {
		const { p, trap } = await runToTrap('main');
		try {
			const crash = p.guardsOf('crash_unreachable');
			assert.deepStrictEqual([trap.reason, trap.threadId], ['exception', 1]);
			assert.match(String(trap.text), /RuntimeError: unreachable/);
			assert.strictEqual(trap.frames[0].funcIndex, crash.index);
			assert.ok(![...p.scan.guardSites.values()].some(site => site.pc === trap.frames[0].pc), 'the top pc is the trapping instruction from the engine, not the last guard');
			assert.deepStrictEqual(trap.frames.slice(0, 3).map(f => f.funcIndex), [crash.index, crash.index, crash.index], 'one frame per recursion level');
			assert.ok(trap.frames.length >= 4, 'main is below them');
			assert.ok(trap.frames.every((f, i) => i === 0 || f.sp > trap.frames[i - 1].sp), 'each outer frame has a higher stack pointer');
			assert.ok(p.debuggee.capabilities.allStop);
		} finally { p.stop(); }
	});

	test('memory can still be read at a trap, and an out-of-range read says so', async () => {
		const { p, trap } = await runToTrap('main');
		try {
			assert.ok(trap.frames.length > 0);
			assert.strictEqual((await p.debuggee.readMemory(trap.frames[0].sp, 64))?.length, 64);
			assert.strictEqual(await p.debuggee.readMemory(0xffffff00, 16), undefined);
		} finally { p.stop(); }
	});

	test('continuing after a trap ends the program with exit code 139', async () => {
		const { p } = await runToTrap('main');
		try {
			await p.debuggee.resume('continue');
			assert.strictEqual((await p.waitForExit()).exitCode, 139);
			assert.ok(await p.stillRunning(100), 'no second stop');
		} finally { p.stop(); }
	});

	test('stepping after a trap also ends the program', async () => {
		const { p } = await runToTrap('main');
		try {
			await p.debuggee.resume('over');
			assert.strictEqual((await p.waitForExit()).exitCode, 139);
		} finally { p.stop(); }
	});

	test('an out-of-bounds access stops with its message and the faulting function on top', async () => {
		const { p, trap } = await runToTrap('oob');
		try {
			assert.deepStrictEqual([trap.reason, trap.threadId], ['exception', 1]);
			assert.match(String(trap.text), /memory access out of bounds/);
			assert.strictEqual(trap.frames[0].funcIndex, p.guardsOf('crash_oob').index);
		} finally { p.stop(); }
	});

	test('a trap on a spawned thread stops that thread, parks the one still spinning, and lists main as still running in join', async () => {
		const { p, trap } = await runToTrap('thread');
		try {
			const crash = p.guardsOf('crash_unreachable'), spin = p.guardsOf('spin_tick');
			assert.strictEqual(trap.reason, 'exception');
			assert.notStrictEqual(trap.threadId, 1, 'the crasher is not the main thread');
			assert.strictEqual(trap.frames[0].funcIndex, crash.index);

			const threads = await until(() => p.debuggee.threads(), ts => ts.length === 3 && ts.filter(t => t.stopped).length === 2, 'the spinner to park');
			const byId = new Map(threads.map(t => [t.id, t]));
			assert.deepStrictEqual(byId.get(trap.threadId)!.frames, trap.frames, 'the trapped thread shows its trap stack');
			const spinner = threads.find(t => t.id !== 1 && t.id !== trap.threadId)!;
			assert.ok(spinner.stopped && spinner.frames.length >= 1, 'the spinning thread is parked with a stack');
			assert.ok([spin.index, p.guardsOf('spinner').index].includes(spinner.frames[0].funcIndex), 'it was spinning in its loop or in spin_tick');
			assert.strictEqual(byId.get(1)!.stopped, false, 'main is blocked in pthread_join, outside any statement');
			assert.strictEqual(byId.get(1)!.frames[0]?.funcIndex, p.guardsOf('main').index, 'its stack ends in the function that called join');

			await new Promise(r => setTimeout(r, 300));
			assert.deepStrictEqual((await p.debuggee.threads()).find(t => t.id === spinner.id)!.frames, spinner.frames, 'the spinner does not advance while the trap is shown');
		} finally { p.stop(); }
	});

	test('continuing after a thread trap ends the whole program with exit code 139', async () => {
		const { p } = await runToTrap('thread');
		try {
			await p.debuggee.resume('continue');
			assert.strictEqual((await p.waitForExit()).exitCode, 139);
		} finally { p.stop(); }
	});

	test('without shared memory a trap is not held: the program just ends with exit code 139', async () => {
		const p = startProgram('trap', false, ['main']);
		try {
			await p.nextStop();
			await p.debuggee.resume('continue');
			assert.strictEqual((await p.waitForExit()).exitCode, 139);
			assert.ok(await p.stillRunning(100), 'no exception stop');
		} finally { p.stop(); }
	});
});

suite('trapStop', () => {
	const thread = (id: number, state: 'running' | 'parked', outermostSp: number | undefined): StubThread => ({
		id, state, frames: outermostSp === undefined ? [] : [{ guard: 4, sp: outermostSp - 16 }, { guard: 8, sp: outermostSp }],
	});

	test('a trap on tid 0 is the main thread, whatever else is running', () => {
		const threads = [thread(1, 'running', 9000), thread(2, 'running', 5000)];
		assert.strictEqual(pickTrappedThread(threads, { tid: 0 })?.id, 1);
		assert.strictEqual(pickTrappedThread([thread(2, 'running', 5000)], { tid: 0 }), undefined, 'no main in the registry: cannot tell');
	});

	test('another thread is found by its stack pointer: the nearest outermost frame at or above it', () => {
		const threads = [thread(1, 'running', 9000), thread(2, 'parked', 5000), thread(3, 'running', 7000), thread(4, 'running', 3000)];
		assert.strictEqual(pickTrappedThread(threads, { tid: 2, stackPointer: 6500 })?.id, 3);
		assert.strictEqual(pickTrappedThread(threads, { tid: 2, stackPointer: 4500 })?.id, 2);
		assert.strictEqual(pickTrappedThread(threads, { tid: 2, stackPointer: 7000 })?.id, 3, 'at the outermost frame itself');
	});

	test('without a stack pointer the single running non-main thread is the one; several are ambiguous', () => {
		assert.strictEqual(pickTrappedThread([thread(1, 'running', 9000), thread(2, 'parked', 5000), thread(3, 'running', 7000)], { tid: 1 })?.id, 3);
		assert.strictEqual(pickTrappedThread([thread(1, 'running', 9000), thread(3, 'running', 7000), thread(4, 'running', 3000)], { tid: 1 }), undefined);
	});

	test('an unmatched stack pointer falls back to the single running thread', () => {
		assert.strictEqual(pickTrappedThread([thread(2, 'parked', 5000), thread(3, 'running', undefined)], { tid: 1, stackPointer: 99999 })?.id, 3);
	});

	const frame = (funcIndex: number, pc: number): DebuggeeFrame => ({ funcIndex, pc, sp: 100 + funcIndex });
	const codeStart = 0x100;
	const trace = (...entries: [number, number][]) => ['RuntimeError: unreachable', ...entries.map(([f, off]) => `    at fn${f} (wasm://wasm/abcd:wasm-function[${f}]:0x${off.toString(16)})`)].join('\n');

	test('refineFrames takes each pc from the trace by function, skipping functions the shadow stack does not know', () => {
		const shadow = [frame(7, 10), frame(5, 20), frame(2, 30)];
		const refined = refineFrames(shadow, trace([9, 0x300], [7, codeStart + 0x44], [6, 0x500], [5, codeStart + 0x88], [2, codeStart + 0x99]), codeStart);
		assert.deepStrictEqual(refined.map(f => f.pc), [0x44, 0x88, 0x99]);
		assert.deepStrictEqual(refined.map(f => f.sp), shadow.map(f => f.sp), 'only the pcs change');
	});

	test('refineFrames keeps the last guard pc of a frame the trace does not mention, and handles recursion in order', () => {
		const refined = refineFrames([frame(7, 10), frame(7, 20), frame(4, 30)], trace([7, codeStart + 1], [7, codeStart + 2]), codeStart);
		assert.deepStrictEqual(refined.map(f => f.pc), [1, 2, 30]);
	});

	test('refineFrames returns the shadow stack untouched without a trace or a code start', () => {
		const shadow = [frame(7, 10)];
		assert.deepStrictEqual(refineFrames(shadow, undefined, codeStart), shadow);
		assert.deepStrictEqual(refineFrames(shadow, trace([7, 1]), undefined), shadow);
	});
});

suite('abort stops before the program exits 134 (real stub)', function () {
	this.timeout(60_000);

	for (const withMemory of [true, false]) {
		test(`abort() stops as an exception with the calling stack, and Continue exits 134 (${withMemory ? 'shared memory' : 'no shared memory'})`, async () => {
			const p = startProgram('aborting', withMemory);
			try {
				await p.nextStop();
				await p.debuggee.resume('continue');
				const stop = await p.nextStop();
				assert.deepStrictEqual([stop.reason, stop.threadId], ['exception', 1]);
				assert.match(String(stop.text), /abort\(\) called.*exit code 134/);
				const fail = p.guardsOf('fail');
				// The fixture's own abort() is instrumented (the shim the extension links is not), so skip its frame.
				const callers = stop.frames.filter(f => f.funcIndex !== p.guardsOf('abort').index);
				assert.strictEqual(callers[0].funcIndex, fail.index, 'the function that called abort is on top');
				assert.ok(callers.filter(f => f.funcIndex === fail.index).length >= 2, 'the recursion shows');
				assert.strictEqual(callers[callers.length - 1].funcIndex, p.guardsOf('__original_main').index, 'main is the outermost frame');
				await p.debuggee.resume('continue');
				assert.strictEqual((await p.waitForExit()).exitCode, 134);
			} finally { p.stop(); }
		});
	}
});
