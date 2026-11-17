import * as assert from 'assert';

/**
 * Probe for the V2 Worker host (documents/design_host.md "Host"): which Worker patterns work inside the web
 * extension host. Needs --coi (see the `test` script in package.json).
 *
 * The decisive case is `nested create then block`: a Worker that creates a child Worker and then blocks in
 * `Atomics.wait` for the child's signal, which is what a synchronous spawn hook or `thread-spawn` would do.
 */
suite('vscwClang Worker mechanics (in browser)', function () {
	this.timeout(60_000);
	const workers: Worker[] = [];

	const spawn = (source: string): Worker => {
		const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
		workers.push(worker);
		return worker;
	};

	teardown(() => { for (const w of workers.splice(0)) { w.terminate(); } });

	const nextMessage = (worker: Worker, timeoutMs: number): Promise<unknown> => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no message within ${timeoutMs} ms`)), timeoutMs);
		worker.onmessage = ev => { clearTimeout(timer); resolve(ev.data); };
		worker.onerror = ev => { clearTimeout(timer); reject(new Error(`worker error: ${ev.message}`)); };
	});

	test('the extension host is cross-origin isolated and can share memory', () => {
		const g = globalThis as { crossOriginIsolated?: boolean };
		assert.strictEqual(g.crossOriginIsolated, true);
		new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
	});

	test('a blocked Worker is woken by the host after an async request (sync-over-async channel)', async () => {
		const sab = new SharedArrayBuffer(16);
		const view = new Int32Array(sab);
		const worker = spawn(`
			onmessage = ev => {
				const view = new Int32Array(ev.data);
				postMessage({ request: true });
				const result = Atomics.wait(view, 0, 0, 10000);
				postMessage({ result, value: view[1] });
			};`);
		const got: unknown[] = [];
		const done = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('worker never finished')), 20_000);
			worker.onmessage = async ev => {
				got.push(ev.data);
				if ((ev.data as { request?: boolean }).request) {
					await new Promise(r => setTimeout(r, 50));
					view[1] = 42;
					Atomics.store(view, 0, 1);
					Atomics.notify(view, 0);
				} else { clearTimeout(timer); resolve(); }
			};
		});
		worker.postMessage(sab);
		await done;
		assert.deepStrictEqual(got[1], { result: 'ok', value: 42 });
	});

	test('a Worker that creates a child Worker and then blocks never sees the child run (so children come from the host)', async () => {
		const sab = new SharedArrayBuffer(16);
		const worker = spawn(`
			onmessage = ev => {
				const view = new Int32Array(ev.data);
				const child = new Worker(URL.createObjectURL(new Blob([
					'onmessage = ev => { const v = new Int32Array(ev.data); Atomics.store(v, 0, 7); Atomics.notify(v, 0); };'
				], { type: 'text/javascript' })));
				child.postMessage(ev.data);
				const result = Atomics.wait(view, 0, 0, 8000);
				postMessage({ result, value: view[0] });
			};`);
		worker.postMessage(sab);
		const reply = await nextMessage(worker, 20_000);
		console.log(`[workerMechanics] nested create then block: ${JSON.stringify(reply)}`);
		// Observed 2026-10-22 (Chromium, test-web): the child never starts while its creator blocks, so spawn hooks and
		// thread-spawn must ask the extension host to create Workers. If this ever returns 'ok', that constraint is gone.
		assert.deepStrictEqual(reply, { result: 'timed-out', value: 0 });
	});

	test('a Worker can ask the host to create a child, then block on it (coordinator)', async () => {
		const sab = new SharedArrayBuffer(16);
		const worker = spawn(`
			onmessage = ev => {
				const view = new Int32Array(ev.data);
				postMessage({ spawn: true });
				const result = Atomics.wait(view, 0, 0, 8000);
				postMessage({ result, value: view[0] });
			};`);
		const childSource = 'onmessage = ev => { const v = new Int32Array(ev.data); Atomics.store(v, 0, 9); Atomics.notify(v, 0); };';
		const reply = await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no reply')), 20_000);
			worker.onmessage = ev => {
				if ((ev.data as { spawn?: boolean }).spawn) { spawn(childSource).postMessage(sab); } else { clearTimeout(timer); resolve(ev.data); }
			};
			worker.postMessage(sab);
		});
		assert.deepStrictEqual(reply, { result: 'ok', value: 9 });
	});
});
