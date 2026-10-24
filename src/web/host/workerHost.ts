import * as vscode from 'vscode';
import type { WorkerLike } from './guestProcess';

/** Where esbuild puts the bundled Worker entry (`guestWorker.web.ts`). */
const WORKER_SCRIPT = ['dist', 'web', 'host', 'guestWorker.web.js'];

/** Whether tools and programs run on the V2 Worker host (`vscwclang.experimental.workerHost`, default on) instead of `wasm-wasi-core`. */
export function workerHostEnabled(): boolean {
	return vscode.workspace.getConfiguration('vscwclang').get<boolean>('experimental.workerHost', true);
}

let scriptUrl: Promise<string> | undefined;

/**
 * Makes a Worker running the guest entry.
 *
 * The extension host cannot start a Worker from an extension URI (different origin), so the bundled script is read
 * and started from a blob URL, as `wasm-wasi-core` does.
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
