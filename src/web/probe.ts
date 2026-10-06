import * as vscode from 'vscode';
import { Wasm, type MemoryFileSystem } from '@vscode/wasm-wasi';
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
	await step(log, 'compile + link + run hello.cpp (clang.wasm, lld.wasm, wasm-wasi-core)', () => probeBuildHello(context, log));
	log.appendLine('--- done ---');
}

async function step(log: vscode.OutputChannel, name: string, fn: () => Promise<string> | string): Promise<void> {
	const start = performance.now();
	try {
		const detail = await fn();
		const line = `[ok]   ${name}: ${detail} (${Math.round(performance.now() - start)} ms)`;
		log.appendLine(line);
	} catch (e) {
		const line = `[FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`;
		log.appendLine(line);
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

interface CompileFlags {
	compile: Record<string, string[]>;
	link: Record<string, string[]>;
}

let lastStderr = '';

async function runTool(wasm: Wasm, log: vscode.OutputChannel, context: vscode.ExtensionContext, sysroot: SysrootFs, wasmFile: string, args: string[]): Promise<number> {
	const bits = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'bin', wasmFile));
	const module = await WebAssembly.compile(bits as Uint8Array<ArrayBuffer>);
	const process = await wasm.createProcess(args[0], module, {
		args: args.slice(1),
		stdio: { out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } },
		mountPoints: [
			{ kind: 'workspaceFolder' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.sysroot, mountPoint: '/sysroot' },
			{ kind: 'memoryFileSystem', fileSystem: sysroot.resource, mountPoint: '/resource' },
		],
	});
	const out = new TextDecoder();
	const err = new TextDecoder();
	let stdout = '';
	let stderr = '';
	process.stdout?.onData(d => { stdout += out.decode(d, { stream: true }); });
	process.stderr?.onData(d => { stderr += err.decode(d, { stream: true }); });
	const rc = await process.run();
	lastStderr = stderr;
	log.appendLine(`[${args[0]} exit ${rc}] stdout: ${stdout}${stderr ? `
stderr: ${stderr}` : ''}`);
	return rc;
}

async function probeBuildHello(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<string> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) {
		throw new Error('open a workspace folder first (the probe writes hello.cpp/.o/.wasm into it)');
	}
	const slice = 'wasm32-wasip1';
	const flagsFile = await phase('read compile-flags.json', () => vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'compile-flags.json')));
	const flags = JSON.parse(new TextDecoder().decode(flagsFile)) as CompileFlags;
	const sub = (f: string) => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
	const source = ['#include <iostream>', 'int main() { std::cout << "hello from vscwClang" << std::endl; return 0; }', ''].join(String.fromCharCode(10));
	await phase(`write hello.cpp to ${folder.toString()}`, () => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'hello.cpp'), new TextEncoder().encode(source)));

	const wasm = await Wasm.load();
	const tz = performance.now();
	const sysroot = await phase('build sysroot memory file systems from sysroot.zip', () => loadSysroot(wasm, context));
	log.appendLine(`sysroot memory FS ready in ${Math.round(performance.now() - tz)} ms`);
	const t0 = performance.now();
	const cc = await phase('run clang', () => runTool(wasm, log, context, sysroot, 'clang.wasm', ['clang++', ...flags.compile[slice].map(sub), '-fno-crash-diagnostics', '-fno-color-diagnostics', '-fno-caret-diagnostics', '-c', '/workspace/hello.cpp', '-o', '/workspace/hello.o']));
	if (cc !== 0) {
		const lines = lastStderr.split(String.fromCharCode(10));
		const from = lines.findIndex(l => l.includes('search starts here'));
		const to = lines.findIndex(l => l.includes('End of search list'));
		throw new Error(`clang exited ${cc}; errors: ${lines.slice(to + 1).filter(l => /error/.test(l)).slice(0, 5).join(' | ')} (search list from ${from} to ${to})`);
	}
	const t1 = performance.now();
	const link = flags.link[slice].map(sub);
	const ld = await phase('run wasm-ld', () => runTool(wasm, log, context, sysroot, 'lld.wasm', ['wasm-ld', link[0], '/workspace/hello.o', ...link.slice(1), '-o', '/workspace/hello.wasm']));
	if (ld !== 0) { throw new Error(`wasm-ld exited ${ld} (see output above)`); }
	const t2 = performance.now();
	const out = await phase('read hello.wasm', () => vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'hello.wasm')));
	const hello = await WebAssembly.compile(out as Uint8Array<ArrayBuffer>);
	const process = await wasm.createProcess('hello', hello, { stdio: { out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } } });
	let printed = '';
	const decoder = new TextDecoder();
	process.stdout?.onData(d => { printed += decoder.decode(d); });
	const rc = await process.run();
	return `clang ${Math.round(t1 - t0)} ms, wasm-ld ${Math.round(t2 - t1)} ms, hello.wasm ${out.byteLength} bytes, ran exit ${rc}: ${JSON.stringify(printed)}`;
}

async function phase<T>(name: string, fn: () => PromiseLike<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

interface SysrootFs {
	sysroot: MemoryFileSystem;
	resource: MemoryFileSystem;
}

async function loadSysroot(wasm: Wasm, context: vscode.ExtensionContext): Promise<SysrootFs> {
	const zipBits = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'llvm-artifacts', 'zips', 'sysroot.zip'));
	const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
		unzip(zipBits, (err, data) => err ? reject(err) : resolve(data)));
	const result: SysrootFs = { sysroot: await wasm.createMemoryFileSystem(), resource: await wasm.createMemoryFileSystem() };
	const made = { sysroot: new Set<string>(), resource: new Set<string>() };
	for (const [path, content] of Object.entries(files)) {
		const root = path.startsWith('sysroot/') ? 'sysroot' : 'resource';
		const rel = path.slice(root.length);
		const parts = rel.split('/').slice(1, -1);
		let dir = '';
		for (const part of parts) {
			dir = dir ? `${dir}/${part}` : part;
			if (!made[root].has(dir)) {
				result[root].createDirectory(dir);
				made[root].add(dir);
			}
		}
		result[root].createFile(rel.slice(1), content);
	}
	return result;
}
