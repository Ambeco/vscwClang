import type { SpawnerMessage, SpawnThreadMessage } from './guestWorker';
import type { WorkerLike } from './guestProcess';
import { newSharedMemory, sharedMemoryLimits } from './sharedMemory';

/** Files the threads of an in-process module may read: copied into shared buffers at each spawn, so `files` sees the latest bytes. */
export interface SharedFiles {
	preopens: string[];
	files: () => Record<string, Uint8Array>;
}

function shareFiles(files: Record<string, Uint8Array>): Record<string, SharedArrayBuffer> {
	return Object.fromEntries(Object.entries(files).map(([path, bytes]) => {
		const buffer = new SharedArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);
		return [path, buffer];
	}));
}

/**
 * Real threads for a wasi-threads module that runs on the calling thread (the lldb reactor on the extension host).
 *
 * The caller blocks in `memory.atomic.wait` while its threads work, and a blocked thread never sees a Worker it created
 * start (Chromium), so `thread-spawn` only posts to a separate spawner Worker, made here before anything blocks, which
 * creates the thread Workers. Threads get no file or stdio service beyond `SharedFiles` (see `ThreadMessage`). `dispose` ends them all.
 */
export class WorkerThreads {
	private readonly spawner: WorkerLike;

	/** `createSpawner` must return a Worker running the guest Worker entry; it is told to act as a spawner here. */
	constructor(createSpawner: () => WorkerLike, onError: (message: string) => void = () => undefined) {
		this.spawner = createSpawner();
		this.spawner.onError(onError);
		this.spawner.onMessage(message => {
			const failed = message as { type?: string; message?: string };
			if (failed.type === 'failed') { onError(failed.message ?? 'the thread spawner failed'); }
		});
		this.spawner.postMessage({ type: 'thread-spawner' } satisfies SpawnerMessage);
	}

	/** The imports a module needs for threads: `memory` is the shared memory built from `wasm`'s declared limits. */
	imports(module: WebAssembly.Module, wasm: Uint8Array, shared?: SharedFiles): { memory: WebAssembly.Memory; imports: WebAssembly.Imports } | undefined {
		const limits = sharedMemoryLimits(wasm);
		if (!limits) { return undefined; }
		const memory = newSharedMemory(limits);
		const tidCounter = new SharedArrayBuffer(4);
		const counter = new Int32Array(tidCounter);
		counter[0] = 1; // 0 is the main thread
		const threads = { memory, tidCounter };
		return {
			memory,
			imports: {
				env: { memory },
				wasi: {
					'thread-spawn': (startArg: number) => {
						const tid = Atomics.add(counter, 0, 1);
						this.spawner.postMessage({ type: 'spawnThread', module, tid, startArg, threads, preopens: shared?.preopens, files: shared && shareFiles(shared.files()) } satisfies SpawnThreadMessage);
						return tid;
					},
				},
			},
		};
	}

	dispose(): void { this.spawner.terminate(); }
}
