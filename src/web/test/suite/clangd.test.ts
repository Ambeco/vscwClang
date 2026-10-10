import * as assert from 'assert';
import * as vscode from 'vscode';
import { Wasm, type WasmProcess } from '@vscode/wasm-wasi';
import { loadSysroot, type SysrootFs } from '../../toolchain/sysroot';
import { getToolchainStore } from '../../toolchain/toolchain';
import { describeUnsupportedImports } from '../../toolchain/wasiImports';
import { GUEST_WORKSPACE } from '../../toolchain/guestPaths';
import { GUEST_TMP } from '../../toolchain/runEnvironment';

/**
 * Host-integration tests for clangd.wasm: does `wasm-wasi-core`'s bidirectional pipe stdio (not the
 * one-shot `run-to-completion` model `build()`/`runProgram()` use) actually carry a real LSP session,
 * and does the chosen no-background-thread indexing mitigation (didOpen/didClose sweep, see
 * documents/remaining_work.md) produce usable cross-file results through this host.
 *
 * clangd.wasm is not published yet (not in the toolchain manifest). Build it from the `llvm-project`
 * fork (`build-single-threaded.bat`) and copy `build-single-threaded/bin/clangd.wasm` to
 * `llvm-artifacts/bin/clangd.wasm` (gitignored) before running this suite; it skips otherwise.
 *
 * Needs a workspace folder, --coi and ms-vscode.wasm-wasi-core (see the `test` script in package.json).
 */
suite('vscwClang clangd (in browser)', function () {
	this.timeout(180_000);

	let dir: vscode.Uri;
	let tmpDir: vscode.Uri;
	let module: WebAssembly.Module;
	let sysroot: SysrootFs;
	let wasm: Wasm;
	const log = vscode.window.createOutputChannel('vscwclang-clangd-test');
	const encoder = new TextEncoder();
	const GUEST_PROJECT = `${GUEST_WORKSPACE}/clangd-test`;
	const write = (name: string, text: string) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), encoder.encode(text));
	const uri = (name: string) => `file://${GUEST_PROJECT}/${name}`;

	suiteSetup(async function () {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		dir = vscode.Uri.joinPath(folder, 'clangd-test');
		await vscode.workspace.fs.createDirectory(dir);
		tmpDir = vscode.Uri.joinPath(folder, 'clangd-test-tmp');
		await vscode.workspace.fs.createDirectory(tmpDir);
		const extension = vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'));
		assert.ok(extension, 'vscwclang extension is not loaded');
		let bits: Uint8Array;
		try {
			bits = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'llvm-artifacts', 'bin', 'clangd.wasm')) as Uint8Array<ArrayBuffer>;
		} catch {
			this.skip();
			return;
		}
		const toolchainUrl = `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/dist`;
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', toolchainUrl, vscode.ConfigurationTarget.Global);
		const context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		const toolchain = getToolchainStore(context, log);
		await toolchain.ensure();
		wasm = await Wasm.load();
		sysroot = await loadSysroot(wasm, toolchain);
		module = await WebAssembly.compile(bits as Uint8Array<ArrayBuffer>);
	});

	test('clangd.wasm does not import anything wasm-wasi-core refuses to run', () => {
		const unsupported = describeUnsupportedImports(WebAssembly.Module.imports(module));
		assert.strictEqual(unsupported, undefined, unsupported);
	});

	const NL = String.fromCharCode(13) + String.fromCharCode(10);

	function frame(obj: unknown): Uint8Array {
		const body = encoder.encode(JSON.stringify(obj));
		const header = encoder.encode(`Content-Length: ${body.length}${NL}${NL}`);
		const out = new Uint8Array(header.length + body.length);
		out.set(header, 0);
		out.set(body, header.length);
		return out;
	}

	function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
		const out = new Uint8Array(a.length + b.length);
		out.set(a, 0);
		out.set(b, a.length);
		return out;
	}

	interface Msg { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }

	/**
	 * Drives one clangd.wasm session over a WasmProcess's pipeIn/pipeOut stdio. Unlike `build()`/`runProgram()`
	 * (run one short-lived process to completion, then read its output), `run()` here is a long-lived promise
	 * that only settles at `shutdown`/`exit`, while requests and replies cross `stdin`/`stdout` concurrently.
	 */
	class LspClient {
		private buf = new Uint8Array(0);
		private nextId = 1;
		private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
		readonly notes: { method: string; params: unknown }[] = [];
		stderr = '';
		exitCode: number | undefined;
		private closed = false;
		private readonly waiters: { check: () => boolean; resolve: () => void }[] = [];
		readonly exited: Promise<number>;

		constructor(private readonly process: WasmProcess) {
			process.stdout!.onData(d => { this.buf = concat(this.buf, d); this.drain(); });
			process.stderr!.onData(d => { this.stderr += new TextDecoder().decode(d); });
			this.exited = process.run().then(code => { this.exitCode = code; this.closed = true; this.wake(); return code; });
		}

		private drain(): void {
			for (;;) {
				const text = new TextDecoder().decode(this.buf);
				const h = text.indexOf(NL + NL);
				if (h < 0) { return; }
				const len = Number(/Content-Length: (\d+)/.exec(text.slice(0, h))?.[1]);
				const headerBytes = encoder.encode(text.slice(0, h + NL.length * 2)).length;
				if (this.buf.length < headerBytes + len) { return; }
				const m = JSON.parse(new TextDecoder().decode(this.buf.subarray(headerBytes, headerBytes + len))) as Msg;
				this.buf = this.buf.subarray(headerBytes + len);
				this.onMessage(m);
			}
		}

		private onMessage(m: Msg): void {
			if (m.method !== undefined && m.id === undefined) {
				this.notes.push({ method: m.method, params: m.params });
			} else if (m.id !== undefined) {
				const p = this.pending.get(m.id);
				if (p) {
					this.pending.delete(m.id);
					if (m.error) { p.reject(new Error(m.error.message)); } else { p.resolve(m.result); }
				}
			}
			this.wake();
		}

		private wake(): void {
			for (let i = this.waiters.length - 1; i >= 0; i--) {
				if (this.waiters[i].check() || this.closed) { this.waiters[i].resolve(); this.waiters.splice(i, 1); }
			}
		}

		async write(obj: unknown): Promise<void> { await this.process.stdin!.write(frame(obj)); }
		async notify(method: string, params: unknown): Promise<void> { await this.write({ jsonrpc: '2.0', method, params }); }

		request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
			const id = this.nextId++;
			const result = new Promise<unknown>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				setTimeout(() => { if (this.pending.delete(id)) { reject(new Error(`timeout waiting for ${method}`)); } }, timeoutMs);
				this.exited.then(code => { if (this.pending.delete(id)) { reject(new Error(`clangd exited (${code}) before answering ${method}\n${this.stderr.slice(-800)}`)); } });
			});
			void this.write({ jsonrpc: '2.0', id, method, params });
			return result;
		}

		async waitNote(pred: (n: { method: string; params: unknown }) => boolean, timeoutMs = 30_000, from = 0): Promise<{ method: string; params: unknown }> {
			const find = () => this.notes.slice(from).find(pred);
			if (!find()) {
				await new Promise<void>((resolve, reject) => {
					const t = setTimeout(() => reject(new Error(`timeout waiting for a notification\n${this.stderr.slice(-800)}`)), timeoutMs);
					this.waiters.push({ check: () => !!find(), resolve: () => { clearTimeout(t); resolve(); } });
				});
			}
			const n = find();
			if (!n) { throw new Error(`clangd exited (${this.exitCode}) while waiting for a notification\n${this.stderr.slice(-800)}`); }
			return n;
		}

		async init(): Promise<void> {
			await this.request('initialize', { processId: null, rootUri: `file://${GUEST_PROJECT}`, capabilities: {} });
			await this.notify('initialized', {});
		}

		open(name: string, text: string, version = 1): Promise<void> {
			return this.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'cpp', version, text } });
		}
		close(name: string): Promise<void> {
			return this.notify('textDocument/didClose', { textDocument: { uri: uri(name) } });
		}

		/** Asks clangd to stop, falling back to terminate() if it does not exit (mirrors vscode-wasm#303: a hung process never settles `run()` on its own). */
		async shutdown(): Promise<number> {
			await this.request('shutdown', null);
			await this.notify('exit', null);
			const timer = setTimeout(() => void this.process.terminate(), 10_000);
			try { return await this.exited; } finally { clearTimeout(timer); }
		}
	}

	async function start(extraFiles: Record<string, string> = {}): Promise<LspClient> {
		for (const [name, text] of Object.entries(extraFiles)) { await write(name, text); }
		const process = await wasm.createProcess('clangd', module, {
			args: ['-sync', '-background-index=false', '-resource-dir=/resource', '-log=error'],
			stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } },
			mountPoints: [
				{ kind: 'workspaceFolder' },
				{ kind: 'memoryFileSystem', fileSystem: sysroot.sysroot, mountPoint: '/sysroot' },
				{ kind: 'memoryFileSystem', fileSystem: sysroot.resource, mountPoint: '/resource' },
				{ kind: 'vscodeFileSystem', uri: tmpDir, mountPoint: GUEST_TMP },
			],
		});
		return new LspClient(process);
	}

	const CPP_FLAGS = ['--target=wasm32-wasip1', '--sysroot=/sysroot', '-resource-dir=/resource',
		'-isystem/sysroot/include/wasm32-wasip1/noeh/c++/v1', '-isystem/sysroot/include/c++/v1', '-fno-exceptions', '-std=c++20'];

	async function withCompileCommands(files: Record<string, string>): Promise<LspClient> {
		const commands = Object.keys(files).filter(n => n.endsWith('.cpp')).map(file => ({
			directory: GUEST_PROJECT, file: `${GUEST_PROJECT}/${file}`, arguments: ['clang', ...CPP_FLAGS, `${GUEST_PROJECT}/${file}`],
		}));
		return start({ ...files, 'compile_commands.json': JSON.stringify(commands) });
	}

	test('starts, initializes, and shuts down cleanly over wasm-wasi-core pipes', async () => {
		const client = await start();
		await client.init();
		const exitCode = await client.shutdown();
		assert.strictEqual(exitCode, 0);
		assert.strictEqual(client.stderr.includes('Assertion') || client.stderr.includes('FATAL'), false, client.stderr);
	});

	test('didOpen on a broken file reports diagnostics back over the pipe', async () => {
		const client = await withCompileCommands({ 'broken.cpp': 'int main() { return undeclared_name; }\n' });
		await client.init();
		await client.open('broken.cpp', 'int main() { return undeclared_name; }\n');
		const note = await client.waitNote(n => n.method === 'textDocument/publishDiagnostics' && (n.params as { uri: string }).uri === uri('broken.cpp'));
		const diags = (note.params as { diagnostics: { message: string }[] }).diagnostics;
		assert.ok(diags.length > 0, 'expected at least one diagnostic');
		assert.ok(diags.some(d => /undeclared_name|undeclared identifier/i.test(d.message)), JSON.stringify(diags));
		await client.shutdown();
	});

	test('hover and go-to-definition resolve for an open file (request/response while the process is alive)', async () => {
		const text = 'int triple(int x) { return x * 3; }\nint main() { return triple(7); }\n';
		const client = await withCompileCommands({ 'main.cpp': text });
		await client.init();
		await client.open('main.cpp', text);
		await client.waitNote(n => n.method === 'textDocument/publishDiagnostics' && (n.params as { uri: string }).uri === uri('main.cpp'));
		const callLine = 1, callChar = text.split('\n')[1].indexOf('triple') + 1;
		const def = await client.request('textDocument/definition', { textDocument: { uri: uri('main.cpp') }, position: { line: callLine, character: callChar } }) as { uri: string; range: { start: { line: number } } }[];
		assert.ok(Array.isArray(def) && def.length > 0, JSON.stringify(def));
		assert.strictEqual(def[0].uri, uri('main.cpp'));
		assert.strictEqual(def[0].range.start.line, 0);
		await client.shutdown();
	});

	test('a large completion response survives the pipe intact (framing/chunking under this host)', async () => {
		// A bare "std::" on its own line (no trailing prefix) is how clangd's own test suite requests an
		// unfiltered member list; `std::;` instead parses as an error-recovery expression with no completions.
		const text = '#include <vector>\n#include <string>\n#include <map>\n#include <algorithm>\nint main() {\n  std::\n}\n';
		const client = await withCompileCommands({ 'big.cpp': text });
		await client.init();
		await client.open('big.cpp', text);
		await client.waitNote(n => n.method === 'textDocument/publishDiagnostics' && (n.params as { uri: string }).uri === uri('big.cpp'));
		const items = await client.request('textDocument/completion', { textDocument: { uri: uri('big.cpp') }, position: { line: 5, character: 7 } }) as { items?: unknown[] } | unknown[];
		const list = Array.isArray(items) ? items : items.items ?? [];
		// std:: in a TU with <vector>/<string>/<map>/<algorithm> has hundreds of members; a short list means the
		// response was truncated or corrupted in transit, which is exactly the class of bug the fork's Node
		// pipe testing found (a short read silently corrupting a later buffered read).
		assert.ok(list.length > 50, `suspiciously short completion list (${list.length} items); possible pipe framing/corruption`);
		await client.shutdown();
	});

	test('fake background indexing (didOpen/didClose sweep) makes a closed file\'s symbols resolvable from another file', async () => {
		const libText = 'int quadruple(int x) { return x * 4; }\n';
		const mainText = '#include "lib.h"\nint main() { return quadruple(5); }\n';
		const libHeader = 'int quadruple(int x);\n';
		const client = await withCompileCommands({ 'lib.cpp': libText, 'lib.h': libHeader, 'main.cpp': mainText });
		await client.init();
		// Sweep: open then close lib.cpp (and its header) without ever opening main.cpp yet, simulating the
		// didOpen/didClose indexing mitigation in documents/remaining_work.md "Chosen indexing mitigation".
		await client.open('lib.cpp', libText);
		await client.waitNote(n => n.method === 'textDocument/publishDiagnostics' && (n.params as { uri: string }).uri === uri('lib.cpp'));
		await client.close('lib.cpp');
		await client.open('main.cpp', mainText);
		await client.waitNote(n => n.method === 'textDocument/publishDiagnostics' && (n.params as { uri: string }).uri === uri('main.cpp'));
		const callLine = 1, callChar = mainText.split('\n')[1].indexOf('quadruple') + 1;
		const def = await client.request('textDocument/definition', { textDocument: { uri: uri('main.cpp') }, position: { line: callLine, character: callChar } }) as { uri: string }[];
		assert.ok(Array.isArray(def) && def.length > 0, `go-to-definition found nothing after the sweep (closed lib.cpp before opening main.cpp): ${JSON.stringify(def)}`);
		assert.strictEqual(def[0].uri, uri('lib.cpp'), 'expected the definition in the now-closed lib.cpp, not a header declaration only');
		await client.shutdown();
	});
});
