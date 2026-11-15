import * as assert from 'assert';
import { readStubThreads } from '../../debug/stubRegistry';
import { startProgram, until } from './threadedProgramHarness';

suite('all-stop: a stop halts every thread (real stub, shared memory)', function () {
	this.timeout(60_000);

	test('a breakpoint on one thread parks the thread that keeps spinning, lists both with stacks, and a resume wakes it', async () => {
		const p = startProgram('allstop');
		try {
			const mainTick = p.guardsOf('main_tick'), threadTick = p.guardsOf('thread_tick'), mainFunc = p.guardsOf('__original_main');
			assert.strictEqual((await p.nextStop()).reason, 'start');
			assert.strictEqual(p.debuggee.capabilities.allStop, true);
			assert.deepStrictEqual((await p.debuggee.threads()).map(t => t.id), [1], 'only main exists before it creates the thread');
			await p.debuggee.setBreakpoints(threadTick.guards);
			await p.debuggee.resume('continue');

			const hit = await p.nextStop();
			assert.strictEqual(hit.reason, 'breakpoint');
			assert.notStrictEqual(hit.threadId, 1, 'thread_tick runs on the created thread');
			assert.strictEqual(hit.frames[0].funcIndex, threadTick.index);

			const settled = await until(() => p.debuggee.threads(), ts => ts.length === 2 && ts.every(t => t.stopped), 'main to park');
			const main = settled.find(t => t.id === 1)!;
			assert.ok(main.frames.length >= 1, 'a parked thread shows its stack');
			assert.ok([mainTick.index, mainFunc.index].includes(main.frames[0].funcIndex), 'main was spinning in its loop or in main_tick');
			assert.deepStrictEqual(settled.find(t => t.id === hit.threadId)!.frames, hit.frames, 'the stopped thread is reported as its own stop frame says');

			await new Promise(r => setTimeout(r, 300));
			assert.deepStrictEqual((await p.debuggee.threads()).find(t => t.id === 1)!.frames, main.frames, 'main does not advance while the program is stopped');

			await p.debuggee.setBreakpoints([]);
			await p.debuggee.resume('continue');
			const running = await until(() => p.debuggee.threads(), ts => ts.every(t => !t.stopped), 'both threads to run again');
			assert.strictEqual(running.length, 2);
			assert.ok(await p.stillRunning(300), 'no leftover stop');
		} finally { p.stop(); }
	});

	test('breakpoints on both threads alternate between them on every continue, and neither deadlocks', async () => {
		const p = startProgram('allstop');
		try {
			const guards = [...p.guardsOf('main_tick').guards, ...p.guardsOf('thread_tick').guards];
			await p.nextStop();
			await p.debuggee.setBreakpoints(guards);
			await p.debuggee.resume('continue');
			const seen = new Set<number>();
			for (let i = 0; i < 6; i++) {
				const stop = await p.nextStop();
				assert.strictEqual(stop.reason, 'breakpoint');
				seen.add(stop.threadId);
				const settled = await until(() => p.debuggee.threads(), ts => ts.length === 2 && ts.every(t => t.stopped), 'the other thread to park');
				assert.ok(settled.every(t => t.frames.length >= 1));
				await p.debuggee.resume('continue');
			}
			assert.deepStrictEqual([...seen].sort(), [1, 2], 'both threads stopped');
		} finally { p.stop(); }
	});

	test('Pause stops every thread, and the pause is consumed', async () => {
		const p = startProgram('allstop');
		try {
			await p.nextStop();
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(300));
			await p.debuggee.pause();
			assert.strictEqual((await p.nextStop()).reason, 'pause');
			const settled = await until(() => p.debuggee.threads(), ts => ts.length === 2 && ts.every(t => t.stopped), 'both threads to park');
			assert.ok(settled.every(t => t.frames.length >= 1));
			await p.debuggee.resume('continue');
			assert.ok(await p.stillRunning(400), 'a pause is consumed by its stop');
		} finally { p.stop(); }
	});

	test('a step moves only the stopped thread, and every thread is stopped again at the end of it', async () => {
		const p = startProgram('allstop');
		try {
			await p.nextStop();
			await p.debuggee.setBreakpoints(p.guardsOf('main_tick').guards);
			await p.debuggee.resume('continue');
			assert.strictEqual((await p.nextStop()).threadId, 1);
			await p.debuggee.setBreakpoints([]);
			await p.debuggee.resume('into');
			const step = await p.nextStop();
			assert.deepStrictEqual([step.reason, step.threadId], ['step', 1]);
			await until(() => p.debuggee.threads(), ts => ts.length === 2 && ts.every(t => t.stopped), 'the worker thread to park again');
		} finally { p.stop(); }
	});

	test('threads that have ended are no longer listed, and more threads than registry slots run fine', async () => {
		const p = startProgram('manythreads');
		try {
			await p.nextStop();
			await p.debuggee.setBreakpoints(p.guardsOf('all_joined').guards);
			await p.debuggee.resume('continue');
			assert.strictEqual((await p.nextStop()).threadId, 1);
			assert.deepStrictEqual((await p.debuggee.threads()).map(t => t.id), [1], 'all 100 workers have exited');
			await p.debuggee.setBreakpoints([]);
			await p.debuggee.resume('continue');
			const { exitCode, stdout } = await p.waitForExit();
			assert.deepStrictEqual([exitCode, stdout], [0, 'total=5050\n']);
		} finally { p.stop(); }
	});

	test('without shared memory a stop only knows its own thread', async () => {
		const p = startProgram('allstop', false);
		try {
			await p.nextStop();
			assert.strictEqual(p.debuggee.capabilities.allStop, false);
			assert.deepStrictEqual(await p.debuggee.threads(), []);
		} finally { p.stop(); }
	});
});

suite('readStubThreads', () => {
	/** A fake memory: registry at 16 with 3 slots, thread stacks at 256 and 512, depth words at 100 and 104. */
	function memory(slots: { id: number; state: number; frames: number; depth: number; guards: [number, number][] }[]) {
		const words = new Uint32Array(1024);
		words[4] = slots.length;
		slots.forEach((s, i) => {
			const at = 5 + i * 5;
			words.set([s.id, 0, s.frames, 100 + i * 4, s.state], at);
			words[(100 + i * 4) >>> 2] = s.depth;
			s.guards.forEach(([guard, sp], d) => words.set([guard, sp], (s.frames >>> 2) + 2 * d));
		});
		return words.buffer;
	}
	const registry = { address: 16, maxThreads: 3 };

	test('a parked thread reads innermost first, a running one has no frames, a dead or free slot is skipped, and ids sort', () => {
		const buffer = memory([
			{ id: 3, state: 2, frames: 1024, depth: 2, guards: [[40, 900], [44, 800]] },
			{ id: 1, state: 1, frames: 2048, depth: 1, guards: [[48, 700]] },
			{ id: 2, state: 3, frames: 2048, depth: 0, guards: [] },
		]);
		assert.deepStrictEqual(readStubThreads(buffer, registry), [
			{ id: 1, state: 'running', frames: [] },
			{ id: 3, state: 'parked', frames: [{ guard: 44, sp: 800 }, { guard: 40, sp: 900 }] },
		]);
	});

	test('a count beyond the capacity is clamped, and a registry outside memory is reported with a hint', () => {
		const buffer = memory([{ id: 1, state: 2, frames: 1024, depth: 0, guards: [] }]);
		new Uint32Array(buffer)[4] = 99;
		assert.strictEqual(readStubThreads(buffer, registry).length, 1, 'slots 1 and 2 are free');
		assert.throws(() => readStubThreads(buffer, { address: 4090, maxThreads: 64 }), /does not fit the program's memory; did the program and debug stub drift apart/);
	});
});
