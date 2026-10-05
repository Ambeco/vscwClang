import * as vscode from 'vscode';

// Environment probe for Milestone 0 (see documents/remaining_work.md); logs findings, changes nothing.

interface WasmCoreApi {
	compile(source: vscode.Uri): Promise<WebAssembly.Module>;
}

export async function runProbe(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
	log.show(true);
	log.appendLine('--- vscwClang probe ---');
	await step(log, 'isolation (extension host)', () => probeIsolation());
	await step(log, 'isolation (nested worker)', () => probeNestedWorker());
	await step(log, 'wasm-wasi-core compile of clang.wasm from extension URI', () => probeWasmCore(context));
}

async function step(log: vscode.OutputChannel, name: string, fn: () => Promise<string> | string): Promise<void> {
	const start = performance.now();
	try {
		const detail = await fn();
		log.appendLine(`[ok]   ${name}: ${detail} (${Math.round(performance.now() - start)} ms)`);
	} catch (e) {
		log.appendLine(`[FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function probeIsolation(): string {
	const g = globalThis as { crossOriginIsolated?: boolean };
	const sab = typeof SharedArrayBuffer === 'function';
	let sharedMemory = 'n/a';
	if (sab) {
		try {
			new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
			sharedMemory = 'ok';
		} catch (e) {
			sharedMemory = `failed: ${e instanceof Error ? e.message : e}`;
		}
	}
	return `crossOriginIsolated=${g.crossOriginIsolated}, SharedArrayBuffer=${sab}, shared WebAssembly.Memory=${sharedMemory}`;
}

function probeNestedWorker(): Promise<string> {
	return new Promise((resolve, reject) => {
		const src = 'postMessage({coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer})';
		const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
		const worker = new Worker(url);
		const timer = setTimeout(() => { worker.terminate(); reject(new Error('no reply from nested Worker within 5 s')); }, 5000);
		worker.onmessage = ev => { clearTimeout(timer); worker.terminate(); resolve(JSON.stringify(ev.data)); };
		worker.onerror = ev => { clearTimeout(timer); reject(new Error(`nested Worker error: ${ev.message}`)); };
	});
}

async function probeWasmCore(context: vscode.ExtensionContext): Promise<string> {
	const ext = vscode.extensions.getExtension('ms-vscode.wasm-wasi-core');
	if (!ext) {
		throw new Error('ms-vscode.wasm-wasi-core is not installed; install it (did you mean to add it to extensionDependencies?)');
	}
	const api = await ext.activate() as { wasm?: WasmCoreApi } | WasmCoreApi;
	const wasm = 'wasm' in api && api.wasm ? api.wasm : api as WasmCoreApi;
	if (typeof wasm.compile !== 'function') {
		throw new Error(`wasm-wasi-core API has no compile(); exports: ${Object.keys(api).join(', ')}`);
	}
	const uri = vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'bin', 'clang.wasm');
	const module = await wasm.compile(uri);
	return `compiled; ${WebAssembly.Module.imports(module).length} imports, ${WebAssembly.Module.exports(module).length} exports`;
}
