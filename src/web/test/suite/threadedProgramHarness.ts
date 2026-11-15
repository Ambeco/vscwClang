import * as assert from 'assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { GuestProcess, StdinQueue, type GuestFileSystem, type WorkerLike } from '../../host/guestProcess';
import { createSharedMemory } from '../../host/sharedMemory';
import { GuestFsError } from '../../host/wasiGuest';
import { scanProgram } from '../../debug/wasmScan';
import { StubDebuggee } from '../../debug/stubDebuggee';
import type { DebuggeeEvent } from '../../debug/debuggeeSession';

/**
 * Runs a debug-stub fixture (`fixtures/debug/<name>stub.wasm`, built by `scripts/build-debug-fixtures.mjs`) on real
 * wasi-threads Workers under a `StubDebuggee`, for node tests of all-stop and traps. Not a test file itself.
 */

const ROOT = process.cwd();
const { buildSync } = createRequire(join(ROOT, 'package.json'))('esbuild') as typeof import('esbuild');

const GUEST_WORKER = buildSync({
	stdin: {
		contents: `import { parentPort } from 'node:worker_threads';
			import { runGuestWorker } from './guestWorker';
			runGuestWorker({ postMessage: (m, t) => parentPort!.postMessage(m, t as never), onMessage: l => { parentPort!.on('message', l); } });`,
		resolveDir: join(ROOT, 'src', 'web', 'host'), loader: 'ts',
	},
	bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;

export function nodeWorker(): WorkerLike {
	const worker = new Worker(GUEST_WORKER, { eval: true });
	return {
		postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
		onMessage: listener => { worker.on('message', listener); },
		onError: listener => { worker.on('error', e => listener(e.message)); },
		terminate: () => { void worker.terminate(); },
	};
}

export const noFiles: GuestFileSystem = {
	stat: async path => { throw new GuestFsError('ENOENT', path); },
	readFile: async path => { throw new GuestFsError('ENOENT', path); },
	writeFile: async () => undefined,
	readDirectory: async () => [],
	createDirectory: async () => undefined,
	delete: async path => { throw new GuestFsError('ENOENT', path); },
	rename: async from => { throw new GuestFsError('ENOENT', from); },
};

export function fixturePath(name: string): string {
	return join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', `${name}stub.wasm`);
}

export type StoppedEvent = Extract<DebuggeeEvent, { kind: 'stopped' }>;

/** Starts the fixture held at its start stop; `withMemory` false hides the shared memory from the host, as `vscwclang.threads` off does. */
export function startProgram(name: string, withMemory = true) {
	const bytes = readFileSync(fixturePath(name));
	const scan = scanProgram(bytes);
	const guardsOf = (funcName: string) => {
		const index = [...scan.module.names].find(([, n]) => n === funcName)?.[0];
		assert.notStrictEqual(index, undefined, `${funcName} is in the name section`);
		return { index: index!, guards: [...scan.guardSites].filter(([, site]) => site.funcIndex === index).map(([guard]) => guard) };
	};
	const memory = createSharedMemory(bytes)!;
	const stdin = new StdinQueue();
	let stdout = '';
	let stderr = '';
	const decoder = new TextDecoder();
	const guest = new GuestProcess({
		module: new WebAssembly.Module(bytes), args: ['prog'], env: {}, preopens: [], fs: noFiles, stdin,
		onOutput: (fd, data) => { if (fd === 2) { debuggee.feedStderr(data); } else { stdout += decoder.decode(data, { stream: true }); } },
		createWorker: nodeWorker, createThreadWorker: nodeWorker, sharedMemory: memory,
	});
	const exited = guest.run().then(outcome => (outcome.kind === 'exit' ? outcome.code : 139));
	const debuggee = new StubDebuggee({
		send: text => stdin.push(new TextEncoder().encode(text)), exited, terminate: () => guest.terminate(),
		onOutput: (stream, text) => { if (stream === 'stderr') { stderr += text; } },
		guardSites: scan.guardSites, memory: withMemory ? memory : undefined,
	});
	void debuggee.start();
	const stops: StoppedEvent[] = [];
	let exitCode: number | undefined;
	let wake: (() => void) | undefined;
	debuggee.listener = e => {
		if (e.kind === 'stopped') { stops.push(e); wake?.(); }
		if (e.kind === 'exited') { exitCode = e.exitCode; wake?.(); }
	};
	const waitFor = async (done: () => boolean, ms: number, what: string) => {
		const deadline = Date.now() + ms;
		while (!done()) {
			const left = deadline - Date.now();
			assert.ok(left > 0, `${what} did not happen within ${ms} ms`);
			await new Promise<void>(resolve => { const t = setTimeout(resolve, left); wake = () => { clearTimeout(t); resolve(); }; });
		}
	};
	return {
		debuggee, scan, guardsOf, memory,
		nextStop: async (ms = 15_000) => { await waitFor(() => stops.length > 0, ms, 'a stop'); return stops.shift()!; },
		/** True if no stop arrives within `ms`. */
		stillRunning: async (ms: number) => { await new Promise(r => setTimeout(r, ms)); return stops.length === 0; },
		waitForExit: async (ms = 15_000) => { await waitFor(() => exitCode !== undefined, ms, 'the exit'); return { exitCode, stdout, stderr }; },
		stop: () => { guest.terminate(); void debuggee.terminate(); },
	};
}

/** Polls `read` until `predicate` holds; a parked thread reaches its state shortly after a stop or a resume. */
export async function until<T>(read: () => Promise<T>, predicate: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (predicate(value)) { return value; }
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 25));
	}
}
