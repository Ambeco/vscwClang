import * as vscode from 'vscode';
import type { GuestProcessOptions, WorkerLike } from './guestProcess';
import { newSharedMemory, type MemoryLimits } from './sharedMemory';

/** Where esbuild puts the bundled Worker entry (`guestWorker.web.ts`). */
const WORKER_SCRIPT = ['dist', 'web', 'host', 'guestWorker.web.js'];

let scriptUrl: Promise<string> | undefined;

/**
 * Makes a Worker running the guest entry.
 *
 * The extension host cannot start a Worker from an extension URI (different origin), so the bundled script is read
 * and started from a blob URL.
 */
export async function createGuestWorker(context: vscode.ExtensionContext): Promise<WorkerLike> {
	scriptUrl ??= (async () => {
		try {
			const code = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, ...WORKER_SCRIPT));
			return URL.createObjectURL(new Blob([code as Uint8Array<ArrayBuffer>], { type: 'text/javascript' }));
		} catch (e) {
			scriptUrl = undefined;
			throw new Error(`vscwClang: cannot load the Worker script ${WORKER_SCRIPT.join('/')}: ${e instanceof Error ? e.message : String(e)}. Did you mean to run 'npm run compile-web' first?`);
		}
	})();
	const worker = new Worker(await scriptUrl);
	return {
		postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
		onMessage: listener => { worker.onmessage = ev => listener(ev.data); },
		onError: listener => { worker.onerror = ev => listener(ev.message || 'the Worker failed to load'); },
		terminate: () => worker.terminate(),
	};
}

/** What a `GuestProcess` needs to run a wasi-threads module (its own shared memory, and Workers for its threads); nothing for other modules. */
export function threadOptions(context: vscode.ExtensionContext, limits: MemoryLimits | undefined): Pick<GuestProcessOptions, 'sharedMemory' | 'createThreadWorker'> {
	return limits ? { sharedMemory: newSharedMemory(limits), createThreadWorker: () => createGuestWorker(context) } : {};
}
