import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { WorkerThreads } from '../host/workerThreads';

// Resolved from the repo, because the compiled tests run from a temp folder with no node_modules.
const { buildSync } = createRequire(join(process.cwd(), 'package.json'))('esbuild') as typeof import('esbuild');

/** The browser's guest Worker entry with node endpoints; a spawner's threads are started from this same code (passed as workerData). */
const WORKER_CODE = buildSync({
	stdin: {
		contents: `
			import { parentPort, workerData, Worker } from 'node:worker_threads';
			import { runGuestWorker } from './guestWorker';
			runGuestWorker({ postMessage: (m, t) => parentPort!.postMessage(m, t as never), onMessage: l => { parentPort!.on('message', l); } }, () => { const w = new Worker(workerData as string, { eval: true, workerData }); return { postMessage: (m: unknown) => w.postMessage(m), onMessage: (l: (m: unknown) => void) => { w.on('message', l); } }; });
		`,
		resolveDir: join(process.cwd(), 'src', 'web', 'host'), loader: 'ts',
	},
	bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;

/** Real threads for a reactor under node: a spawner `worker_threads` Worker, as the extension host has in the browser. */
export function nodeReactorThreads(): WorkerThreads {
	const worker = new Worker(WORKER_CODE, { eval: true, workerData: WORKER_CODE });
	return new WorkerThreads(() => ({
		postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
		onMessage: listener => { worker.on('message', listener); },
		onError: listener => { worker.on('error', e => listener(e.message)); },
		terminate: () => { void worker.terminate(); },
	}), message => { throw new Error(message); });
}
