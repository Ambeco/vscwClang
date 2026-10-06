import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { unzip } from 'fflate';
import { readChunked } from './toolchain/chunkedFile';

// Environment probe for Milestone 0 (see documents/remaining_work.md); logs findings, changes nothing.


export async function runProbe(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
	log.show(true);
	log.appendLine('--- vscwClang probe ---');
	await step(log, 'isolation (extension host)', () => probeIsolation());
	await step(log, 'isolation (nested worker)', () => probeNestedWorker());
	await step(log, 'chunked read + compile of clang.wasm (7 x 16 MiB, sha256-checked)', () => probeChunked(context));
	await step(log, 'unzip clang.zip, compile, run `clang --version`', () => probeZipRun(context));
	for (const url of FETCH_TARGETS) {
		await step(log, `fetch ${url}`, () => probeFetch(url));
	}
	await step(log, 'wasm-wasi-core load + compile clang.wasm from extension URI', () => probeWasmCore(context));
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
	const wasm = await Wasm.load();
	const uri = vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'bin', 'clang.wasm');
	const bits = await vscode.workspace.fs.readFile(uri);
	const module = await WebAssembly.compile(bits as Uint8Array<ArrayBuffer>);
	return `read ${bits.byteLength} bytes and compiled; ${WebAssembly.Module.imports(module).length} imports, ${WebAssembly.Module.exports(module).length} exports`;
}

async function probeChunked(context: vscode.ExtensionContext): Promise<string> {
	const bits = await readChunked(vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'chunks'), 'clang.wasm');
	const module = await WebAssembly.compile(bits);
	return `reassembled ${bits.byteLength} bytes, hash ok, compiled; ${WebAssembly.Module.exports(module).length} exports`;
}

const FETCH_TARGETS = [
	'https://raw.githubusercontent.com/Ambeco/llvm-project/main/README.md',
	'https://cdn.jsdelivr.net/npm/@vscode/wasm-wasi@1.0.1/package.json',
	'https://unpkg.com/@vscode/wasm-wasi@1.0.1/package.json',
	'https://cdn.jsdelivr.net/npm/typescript@5.4.5/lib/typescript.js',
];

async function probeFetch(url: string): Promise<string> {
	const res = await fetch(url, { mode: 'cors' });
	const bytes = (await res.arrayBuffer()).byteLength;
	return `HTTP ${res.status}, ${bytes} bytes`;
}

async function probeZipRun(context: vscode.ExtensionContext): Promise<string> {
	const zipBits = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'zips', 'clang.zip'));
	const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
		unzip(zipBits, (err, data) => err ? reject(err) : resolve(data)));
	const bits = files['clang.wasm'];
	if (!bits) {
		throw new Error(`clang.zip has no clang.wasm entry; entries: ${Object.keys(files).join(', ')}`);
	}
	const module = await WebAssembly.compile(bits as Uint8Array<ArrayBuffer>);
	const wasm = await Wasm.load();
	const process = await wasm.createProcess('clang', module, { args: ['--version'], stdio: { out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } } });
	let output = '';
	const decoder = new TextDecoder();
	process.stdout?.onData(d => { output += decoder.decode(d); });
	process.stderr?.onData(d => { output += decoder.decode(d); });
	const exitCode = await process.run();
	return `unzipped ${bits.byteLength} bytes; exit ${exitCode}; output: ${JSON.stringify(output.slice(0, 200))}`;
}
