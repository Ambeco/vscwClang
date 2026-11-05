import * as vscode from 'vscode';
import type { WasmerLike } from './wasmerProcess';
import type { FileTree } from './workspaceSync';

type WasmerSdk = WasmerLike & { close(): Promise<void> };

let loaded: { base: string; wasmer: Promise<WasmerSdk> } | undefined;

/**
 * Makes `new Worker(url, { type: 'module' })` work in the extension host.
 *
 * VS Code wraps every extension-host Worker URL in a classic `importScripts(url)` script, which a module script
 * rejects, and the Wasmer SDK starts module Workers. A module Worker is replaced by a classic one that
 * `import()`s the URL; messages that arrive before the import finishes are replayed to the module's handlers.
 * Installed lazily, once, and only module Workers are touched.
 */
function installModuleWorkerShim(): void {
	const g = globalThis as unknown as { Worker: typeof Worker; __vscwclangWorkerShim?: boolean };
	if (g.__vscwclangWorkerShim) { return; }
	const Original = g.Worker;
	g.Worker = class extends Original {
		constructor(url: string | URL, options?: WorkerOptions) {
			if (options?.type === 'module') {
				const absolute = new URL(String(url), (globalThis as { location?: { href: string } }).location?.href).href;
				const source = `const q=[];const h=e=>q.push(e);self.addEventListener('message',h);import(${JSON.stringify(absolute)}).then(()=>{self.removeEventListener('message',h);for(const e of q){self.dispatchEvent(new MessageEvent('message',{data:e.data,ports:[...e.ports]}));}});`;
				super(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), { ...options, type: 'classic' });
			} else {
				super(url, options);
			}
		}
	};
	g.__vscwclangWorkerShim = true;
}

/**
 * The Wasmer SDK, loaded once per session from the folder `vscwclang.wasmerSdkUrl` names (its `dist/` and `pkg/`).
 *
 * The SDK cannot be bundled: it fetches its own wasm and starts Workers relative to its URL. Fails with a message
 * saying what to set when the setting is empty or the URL does not serve the SDK; it never falls back to another host.
 */
export function getWasmer(): Promise<WasmerSdk> {
	const base = (vscode.workspace.getConfiguration('vscwclang').get<string>('wasmerSdkUrl', '') ?? '').trim().replace(/\/$/, '');
	if (!base) {
		return Promise.reject(new Error('vscwClang: vscwclang.run.host is "wasmer" but vscwclang.wasmerSdkUrl is empty. Did you mean to set it to a URL serving the folder of @wasmer/sdk (its dist/ and pkg/ folders; with CORS and Cross-Origin-Resource-Policy: cross-origin headers), or to set vscwclang.run.host back to "worker"?'));
	}
	if (loaded?.base === base) { return loaded.wasmer; }
	installModuleWorkerShim();
	const wasmer = (async () => {
		let module: { Wasmer: { create(options?: object): Promise<WasmerSdk> } };
		try {
			module = await import(/* webpackIgnore: true */ `${base}/dist/index.js`);
		} catch (e) {
			throw new Error(`vscwClang: cannot load the Wasmer SDK from ${base}/dist/index.js: ${e instanceof Error ? e.message : String(e)}. Did you mean to check vscwclang.wasmerSdkUrl, and that the server sends CORS and Cross-Origin-Resource-Policy: cross-origin headers?`);
		}
		return module.Wasmer.create();
	})();
	loaded = { base, wasmer };
	wasmer.catch(() => { if (loaded?.wasmer === wasmer) { loaded = undefined; } });
	return wasmer;
}

/** The workspace folder as a `FileTree` over `vscode.workspace.fs`. */
export function workspaceTree(root: vscode.Uri): FileTree {
	const fs = vscode.workspace.fs;
	const uri = (path: string): vscode.Uri => (path ? vscode.Uri.joinPath(root, ...path.split('/')) : root);
	return {
		readDir: async path => (await fs.readDirectory(uri(path))).map(([name, type]) => ({ name, isDir: (type & vscode.FileType.Directory) !== 0 })),
		readFile: path => Promise.resolve(fs.readFile(uri(path))),
		writeFile: async (path, data) => {
			const slash = path.lastIndexOf('/');
			if (slash > 0) { await fs.createDirectory(uri(path.slice(0, slash))); }
			await fs.writeFile(uri(path), data);
		},
		remove: path => Promise.resolve(fs.delete(uri(path), { recursive: true, useTrash: false })),
		mkdir: path => Promise.resolve(fs.createDirectory(uri(path))),
	};
}
