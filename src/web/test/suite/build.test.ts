import * as assert from 'assert';
import * as vscode from 'vscode';
import { createWorkerProcess } from '../../host/workerProcess';
import { sharedMemoryLimits } from '../../host/sharedMemory';
import { build } from '../../toolchain/toolchain';
import { chooseArtifactDir } from '../../buildWorkspace';
import { runProgram } from '../../runProgram';
import { createTaskProvider } from '../../tasks';
import { userFlags } from '../../projectConfig';
import { ToolchainStore, type StoreUi } from '../../toolchain/toolchainStore';

// Needs a workspace folder and --coi (see the `test` script in package.json).
suite('vscwClang build (in browser)', function () {
	this.timeout(180_000);
	const encoder = new TextEncoder();
	const FLAGS_SOURCE = ['#include <cmath>', '#include <cstdio>', '#ifndef ANSWER', '#define ANSWER 40', '#endif',
		'int main() { std::printf("%d", ANSWER + (int)std::sqrt(4.0)); return 0; }', ''].join(String.fromCharCode(10));
	let context: vscode.ExtensionContext;
	let dir: vscode.Uri;
	let toolchainUrl: string;
	const log = vscode.window.createOutputChannel('vscwclang-test');

	const write = (name: string, text: string) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), encoder.encode(text));
	const uri = (name: string) => vscode.Uri.joinPath(dir, name);

	async function runWasm(output: vscode.Uri): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const bytes = await vscode.workspace.fs.readFile(output) as Uint8Array<ArrayBuffer>;
		const process = await createWorkerProcess(context, { name: 'prog', module: await WebAssembly.compile(bytes), args: [], env: {}, mounts: [], memoryLimits: sharedMemoryLimits(bytes) });
		let stdout = '', stderr = '';
		const decoder = new TextDecoder();
		process.stdout?.onData(d => { stdout += decoder.decode(d, { stream: true }); });
		process.stderr?.onData(d => { stderr += decoder.decode(d, { stream: true }); });
		return { exitCode: await process.run(), stdout, stderr };
	}

	suiteSetup(async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		dir = vscode.Uri.joinPath(folder, 'build-test');
		const extension = vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'));
		assert.ok(extension, 'vscwclang extension is not loaded');
		// The toolchain is served over HTTP from the extension dir (`npm run toolchain-dist`) and downloaded into a fresh storage dir.
		toolchainUrl = `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/mtdist`;
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', toolchainUrl, vscode.ConfigurationTarget.Global);
		context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
	});

	test('toolchain downloads into extension storage, then is served from cache', async () => {
		const store = new ToolchainStore(context, log);
		await store.ensure();
		const manifest = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(`${toolchainUrl}/manifest.json`)))) as { files: Record<string, { size: number }> };
		const cached = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(context.globalStorageUri, 'toolchain'));
		const versionDir = cached.find(([, type]) => type === vscode.FileType.Directory)?.[0];
		assert.ok(versionDir, `no version directory in storage: ${JSON.stringify(cached)}`);
		for (const name of ['clang.wasm', 'lld.wasm', 'sysroot.zip', 'compile-flags.json']) {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(context.globalStorageUri, 'toolchain', versionDir, name));
			assert.strictEqual(stat.size, manifest.files[name].size, name);
		}
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', 'http://127.0.0.1:1/unreachable', vscode.ConfigurationTarget.Global);
		try {
			// An override URL is never pinned, so its manifest is always fetched: an unreachable host must fail loudly, not silently reuse the cache.
			await assert.rejects(new ToolchainStore(context, log).ensure(), /could not reach/);
		} finally {
			await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', toolchainUrl, vscode.ConfigurationTarget.Global);
		}
		assert.strictEqual((await new ToolchainStore(context, log).getFile('compile-flags.json')).byteLength, manifest.files['compile-flags.json'].size);
	});

	test('a failing download shows one dialog with Retry / Show Log; Retry asks again; success fires onDidEnsure', async () => {
		const errors: { message: string; items: string[] }[] = [];
		const answers = ['Retry', undefined];
		const ui: StoreUi = {
			showErrorMessage: (message, ...items) => { errors.push({ message, items }); return Promise.resolve(answers.shift()); },
			showInformationMessage: () => Promise.resolve(undefined),
		};
		const failingContext = { ...context, globalStorageUri: vscode.Uri.joinPath(dir, 'storage-failing') } as vscode.ExtensionContext;
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', 'http://127.0.0.1:1/unreachable', vscode.ConfigurationTarget.Global);
		try {
			const store = new ToolchainStore(failingContext, log, { ui, retryDelayMs: 1 });
			let ensured = 0;
			store.onDidEnsure(() => ensured++);
			await assert.rejects(store.ensure(), /could not reach/);
			for (let i = 0; i < 200 && errors.length < 2; i++) { await new Promise(r => setTimeout(r, 50)); }
			assert.strictEqual(errors.length, 2, 'the first dialog and the one Retry raised');
			assert.deepStrictEqual(errors[0].items, ['Retry', 'Show Log']);
			assert.match(errors[0].message, /cannot function until it successfully downloads the clang tools[\s\S]*does not need internet after those are downloaded/);
			assert.strictEqual(ensured, 0, 'a failed ensure must not fire onDidEnsure');
		} finally {
			await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', toolchainUrl, vscode.ConfigurationTarget.Global);
		}
		const recovered = new ToolchainStore(failingContext, log, { ui });
		let fired = 0;
		recovered.onDidEnsure(() => fired++);
		await recovered.ensure();
		assert.strictEqual(fired, 1);
	});

	test('a user-initiated command during a running download is told the download is still in progress', async () => {
		const infos: string[] = [];
		const ui: StoreUi = { showErrorMessage: () => Promise.resolve(undefined), showInformationMessage: message => { infos.push(message); return Promise.resolve(undefined); } };
		const busyContext = { ...context, globalStorageUri: vscode.Uri.joinPath(dir, 'storage-busy') } as vscode.ExtensionContext;
		const store = new ToolchainStore(busyContext, log, { ui });
		const first = store.ensure();
		const second = store.ensure(undefined, { userInitiated: true });
		await Promise.all([first, second]);
		assert.strictEqual(infos.length, 1);
		assert.match(infos[0], /cannot function until it has downloaded the clang tools[\s\S]*still in progress/);
		await store.ensure(undefined, { userInitiated: true });
		assert.strictEqual(infos.length, 1, 'nothing running, so no message');
	});

	test('multi-file project builds, links and runs', async () => {
		await write('util.h', '#pragma once\nint twice(int);\n');
		await write('util.cpp', '#include "util.h"\nint twice(int x) { return x * 2; }\n');
		await write('main.cpp', '#include <iostream>\n#include "util.h"\nint main() { std::cout << "hello " << twice(21) << std::endl; return 0; }\n');
		const output = uri('out.wasm');
		const result = await build({ sources: [uri('main.cpp'), uri('util.cpp')], output, flags: ['-std=c++20', '-Wall'], mode: 'release' }, log, context);
		assert.strictEqual(result.exitCode, 0, result.diagnostics);
		const ran = await runWasm(output);
		assert.deepStrictEqual([ran.exitCode, ran.stdout], [0, 'hello 42\n']);
	});

	test('precompiled headers: used for matching flags, skipped for others, retried without on a name clash', async () => {
		const logged: string[] = [];
		const watch = { ...log, appendLine: (s: string) => { logged.push(s); log.appendLine(s); } } as vscode.OutputChannel;
		const compile = async (name: string, text: string, flags: string[]) => {
			await write(`${name}.cpp`, text);
			logged.length = 0;
			const result = await build({ sources: [uri(`${name}.cpp`)], output: uri(`${name}.wasm`), flags, mode: 'release' }, watch, context);
			assert.strictEqual(result.exitCode, 0, result.diagnostics);
			const line = logged.find(l => / compiled /.test(l)) ?? '(not compiled)';
			return { precompiled: line.includes('precompiled headers'), retried: logged.some(l => /compiling again without them/.test(l)), ran: (await runWasm(uri(`${name}.wasm`))).stdout, line };
		};
		const program = '#include <iostream>\n#include <vector>\nint main() { std::vector<int> v{1, 2, 3}; std::cout << v.size(); }\n';
		const flagged = [
			await compile('pch-default', program, []),
			await compile('pch-cxx20', program, ['-std=c++20', '-Wall']),
			await compile('pch-o2', program, ['-O2']),
			await compile('pch-define', program, ['-DNDEBUG']),
			await compile('pch-macro-first', '#define GREETING 1\n' + program, []),
			await compile('pch-no-include', '#include <cstdio>\nint main() { std::printf("3"); }\n', []),
		];
		assert.deepStrictEqual(flagged.map(f => [f.precompiled, f.ran]), [[true, '3'], [true, '3'], [true, '3'], [false, '3'], [false, '3'], [false, '3']], flagged.map(f => f.line).join('\n'));
		// `rand` is declared by the PCH's C headers but not by a bare <vector>, so only the PCH compile fails on it.
		const clash = await compile('pch-clash', '#include <vector>\nint rand = 5;\nint main() { return rand - 5; }\n', []);
		assert.deepStrictEqual([clash.precompiled, clash.retried], [false, true], clash.line);
		const off = await vscode.workspace.getConfiguration('vscwclang').update('precompiledHeaders', false, vscode.ConfigurationTarget.Global).then(() => compile('pch-off', program + '// off\n', []));
		await vscode.workspace.getConfiguration('vscwclang').update('precompiledHeaders', undefined, vscode.ConfigurationTarget.Global);
		assert.deepStrictEqual([off.precompiled, off.ran], [false, '3'], off.line);
	});

	test('incremental rebuild: an unchanged tree skips everything; an edit recompiles only what includes it', async () => {
		const logged: string[] = [];
		const watch = { ...log, appendLine: (s: string) => { logged.push(s); log.appendLine(s); } } as vscode.OutputChannel;
		const rebuild = async (): Promise<{ compiled: string[]; linked: boolean; ran: string }> => {
			logged.length = 0;
			const result = await build({ sources: [uri('inc-main.cpp'), uri('inc-a.cpp'), uri('inc-b.cpp')], output: uri('inc.wasm'), flags: [], mode: 'release' }, watch, context);
			assert.strictEqual(result.exitCode, 0, result.diagnostics);
			return { compiled: logged.filter(l => / compiled /.test(l)).map(l => /inc-\w+\.cpp/.exec(l)![0]), linked: logged.some(l => /\blinked in\b/.test(l)), ran: (await runWasm(uri('inc.wasm'))).stdout };
		};
		await write('inc-a.h', '#pragma once\nint a();\n');
		await write('inc-a.cpp', '#include "inc-a.h"\nint a() { return 1; }\n');
		await write('inc-b.cpp', 'int b() { return 10; }\n');
		await write('inc-main.cpp', '#include <cstdio>\n#include "inc-a.h"\nint b();\nint main() { std::printf("%d", a() + b()); }\n');
		const first = await rebuild();
		assert.deepStrictEqual([first.compiled.length, first.linked, first.ran], [3, true, '11']);
		const again = await rebuild();
		assert.deepStrictEqual([again.compiled, again.linked, again.ran], [[], false, '11']);
		await write('inc-b.cpp', 'int b() { return 20; }\n');
		const sourceEdit = await rebuild();
		assert.deepStrictEqual([sourceEdit.compiled, sourceEdit.linked, sourceEdit.ran], [['inc-b.cpp'], true, '21']);
		await write('inc-a.h', '#pragma once\nint a();\n// touched\n');
		const headerEdit = await rebuild();
		// The comment changes no object byte, and objects are identified by content, so the link is skipped too.
		assert.deepStrictEqual([headerEdit.compiled.sort(), headerEdit.linked], [['inc-a.cpp', 'inc-main.cpp'], false]);
	});

	test('objects stay in memory: no scratch folder is written to the workspace', async () => {
		await write('quiet.cpp', 'int main() { return 0; }' + String.fromCharCode(10));
		const result = await build({ sources: [uri('quiet.cpp')], output: uri('quiet.wasm'), flags: [], mode: 'release' }, log, context);
		assert.strictEqual(result.exitCode, 0, result.diagnostics);
		const entries = (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
		assert.ok(entries.includes('quiet.wasm'), entries.join(', '));
		assert.ok(!entries.includes('.vscwclang'), `unexpected scratch folder in ${entries.join(', ')}`);
		const top = (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(dir, '..'))).map(([name]) => name);
		assert.ok(!top.includes('.vscwclang'), top.join(', '));
	});

	test('-I<project root> lets sources include headers relative to the project', async () => {
		const nl = String.fromCharCode(10);
		await vscode.workspace.fs.createDirectory(uri('lib/sub'));
		await vscode.workspace.fs.createDirectory(uri('app'));
		await write('lib/sub/value.hpp', '#pragma once' + nl + 'inline int value() { return 7; }' + nl);
		await write('app/rooted.cpp', '#include "lib/sub/value.hpp"' + nl + 'int main() { return value() - 7; }' + nl);
		const failing = await build({ sources: [uri('app/rooted.cpp')], output: uri('rooted.wasm'), flags: [], mode: 'release' }, log, context);
		assert.notStrictEqual(failing.exitCode, 0);
		assert.match(failing.diagnostics, /lib\/sub\/value\.hpp' file not found/);
		const ok = await build({ sources: [uri('app/rooted.cpp')], output: uri('rooted.wasm'), flags: ['-I/workspace/build-test'], mode: 'release' }, log, context);
		assert.strictEqual(ok.exitCode, 0, ok.diagnostics);
		assert.strictEqual((await runWasm(uri('rooted.wasm'))).exitCode, 0);
	});

	test('artifacts default to .vscwclang/<mode>/ in a writable folder, and the output may live outside the workspace', async () => {
		const folder = vscode.workspace.workspaceFolders![0].uri;
		const dirRelease = await chooseArtifactDir(context, folder, 'release');
		const dirDebug = await chooseArtifactDir(context, folder, 'debug');
		assert.strictEqual(dirRelease.toString(), vscode.Uri.joinPath(folder, '.vscwclang/release').toString());
		assert.strictEqual(dirDebug.toString(), vscode.Uri.joinPath(folder, '.vscwclang/debug').toString());
		// Read-only/virtual folders put the output in extension storage, which is mounted at /out rather than /workspace.
		await write('elsewhere.cpp', 'int main() { return 5; }' + String.fromCharCode(10));
		const output = vscode.Uri.joinPath(context.globalStorageUri, 'artifacts', 'k', 'release', 'a.out.wasm');
		const result = await build({ sources: [uri('elsewhere.cpp')], output, flags: [], mode: 'release' }, log, context);
		assert.strictEqual(result.exitCode, 0, result.diagnostics);
		assert.strictEqual((await runWasm(output)).exitCode, 5);
	});

	// runProgram with a recording pseudoterminal; `onOutput` can type input in reply to what the program printed.
	async function runInTerminal(wasmFile: vscode.Uri, args: string[], onOutput?: (text: string, pty: { handleInput?(data: string): void }) => void): Promise<{ exitCode: number; text: string }> {
		let text = '';
		const exitCode = await Promise.race([
			runProgram(context, wasmFile, args, {
				openTerminal: pty => {
					pty.onDidWrite(d => { text += d; onOutput?.(text, pty); });
					pty.open();
				},
			}),
			new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`run hung; output so far: ${JSON.stringify(text)}`)), 20000)),
		]);
		return { exitCode, text };
	}

	test('Run gives the program HOME/TMPDIR, writable /tmp and /home/user, and its arguments', async function () {
		this.timeout(60_000);
		const nl = String.fromCharCode(10);
		await write('envprog.cpp', ['#include <cstdio>', '#include <cstdlib>',
			'static const char* env(const char* k) { const char* v = std::getenv(k); return v ? v : "(null)"; }',
			'int main(int argc, char** argv) {',
			'  std::printf("HOME=%s TMPDIR=%s USER=%s LANG=%s EXTRA=%s\\n", env("HOME"), env("TMPDIR"), env("USER"), env("LANG"), env("EXTRA"));',
			'  FILE* f = std::fopen("/tmp/x.txt", "w"); if (!f) { std::puts("tmp-open-failed"); return 3; } std::fputs("tmpdata", f); std::fclose(f);',
			'  char b[16] = {0}; f = std::fopen("/tmp/x.txt", "r"); std::fgets(b, 16, f); std::fclose(f); std::printf("tmp=%s\\n", b);',
			'  f = std::fopen("/home/user/h.txt", "w"); std::printf("home=%d\\n", f != nullptr); if (f) std::fclose(f);',
			'  for (int i = 1; i < argc; i++) std::printf("arg%d=[%s]\\n", i, argv[i]);',
			'  f = std::fopen("vscw-rel-probe.txt", "r"); std::printf("rel=%d\\n", f != nullptr);',
			'  f = std::fopen("/workspace/vscw-rel-probe.txt", "r"); std::printf("abs=%d\\n", f != nullptr);',
			'  return 0; }', ''].join(nl));
		const output = uri('envprog.wasm');
		const built = await build({ sources: [uri('envprog.cpp')], output, flags: [], mode: 'release' }, log, context);
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		const rootProbe = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'vscw-rel-probe.txt');
		await vscode.workspace.fs.writeFile(rootProbe, encoder.encode('x'));
		const config = vscode.workspace.getConfiguration('vscwclang');
		await config.update('run.env', { EXTRA: 'yes', LANG: null }, vscode.ConfigurationTarget.Global);
		try {
			const ran = await runInTerminal(output, ['in.txt', 'two words']);
			assert.strictEqual(ran.exitCode, 0, ran.text);
			assert.match(ran.text, /HOME=\/home\/user TMPDIR=\/tmp USER=user LANG=\(null\) EXTRA=yes/);
			assert.match(ran.text, /tmp=tmpdata/);
			assert.match(ran.text, /home=1/);
			assert.match(ran.text, /rel=1/, 'relative paths resolve against the workspace folder');
			assert.match(ran.text, /abs=1/);
			assert.match(ran.text, /arg1=\[in\.txt\]/);
			assert.match(ran.text, /arg2=\[two words\]/);
		} finally {
			await config.update('run.env', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	for (const [when, delayMs] of [['before the program reads (typed ahead)', 0], ['after the program is already waiting', 400]] as const) {
	test(`Run: a program reading std::cin gets what is typed into the terminal ${when}, echoed beside its output`, async function () {
		this.timeout(60_000);
		const nl = String.fromCharCode(10);
		await write('cinprog.cpp', ['#include <iostream>', '#include <string>',
			'int main() { std::string name; int n = 0; std::cout << "name? " << std::flush; std::cin >> name >> n;',
			'  std::cout << "Hello, " << name << " x" << n << std::endl; return 0; }', ''].join(nl));
		const output = uri('cinprog.wasm');
		const built = await build({ sources: [uri('cinprog.cpp')], output, flags: [], mode: 'release' }, log, context);
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		let typed = false;
		const ran = await runInTerminal(output, [], (text, pty) => {
			if (!typed && text.includes('name? ')) { typed = true; const type = () => { for (const key of 'Bob 7\r') { pty.handleInput?.(key); } }; if (delayMs === 0) { type(); } else { setTimeout(type, delayMs); } }
		});
		assert.strictEqual(ran.exitCode, 0, ran.text);
		assert.match(ran.text, /name\? Bob 7/, 'typed input is echoed after the prompt');
		assert.match(ran.text, /Hello, Bob x7/);
		assert.match(ran.text, /exited with code 0/);
	});
	}

	const THREAD_SOURCE = ['#include <cstdio>', '#include <mutex>', '#include <thread>', '#include <vector>',
		'int main() {', '  std::mutex m; int total = 0; std::vector<std::thread> threads;',
		'  for (int t = 0; t < 4; t++) threads.emplace_back([&] { for (int i = 0; i < 1000; i++) { std::lock_guard<std::mutex> g(m); total++; } });',
		'  for (auto& t : threads) t.join();', '  std::printf("total=%d", total); return total == 4000 ? 0 : 1; }', ''].join(String.fromCharCode(10));

	test('std::thread and std::mutex build and run by default (threaded slice), also under -pthread', async () => {
		await write('threads.cpp', THREAD_SOURCE);
		for (const flags of [[], ['-pthread']]) {
			const built = await build({ sources: [uri('threads.cpp')], output: uri('threads.wasm'), flags, mode: 'release' }, log, context);
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			const ran = await runWasm(uri('threads.wasm'));
			assert.deepStrictEqual([ran.exitCode, ran.stdout], [0, 'total=4000'], `${flags.join(' ')} ${ran.stderr}`);
		}
	});

	test('with vscwclang.threads off the program is single-threaded; -pthread still selects threads', async () => {
		const config = vscode.workspace.getConfiguration('vscwclang');
		await config.update('threads', false, vscode.ConfigurationTarget.Global);
		try {
			await write('plain.cpp', ['#include <cstdio>', 'int main() { std::puts("plain"); return 0; }', ''].join(String.fromCharCode(10)));
			const single = await build({ sources: [uri('plain.cpp')], output: uri('plain.wasm'), flags: [], mode: 'release' }, log, context);
			assert.strictEqual(single.exitCode, 0, single.diagnostics);
			assert.strictEqual(sharedMemoryLimits(await vscode.workspace.fs.readFile(uri('plain.wasm'))), undefined, 'owns its memory');
			const threaded = await build({ sources: [uri('plain.cpp')], output: uri('plain-t.wasm'), flags: ['-pthread'], mode: 'release' }, log, context);
			assert.strictEqual(threaded.exitCode, 0, threaded.diagnostics);
			assert.ok(sharedMemoryLimits(await vscode.workspace.fs.readFile(uri('plain-t.wasm'))), 'imports shared memory');
			assert.strictEqual((await runWasm(uri('plain.wasm'))).stdout, 'plain\n');
		} finally {
			await config.update('threads', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('a failed assert exits with 134 instead of trapping', async () => {
		const nl = String.fromCharCode(10);
		await write('aborting.cpp', ['#include <cassert>', '#include <cstdio>', 'int main(int argc, char**) { std::puts("before"); assert(argc == 99); std::puts("after"); return 0; }', ''].join(nl));
		const built = await build({ sources: [uri('aborting.cpp')], output: uri('aborting.wasm'), flags: [], mode: 'release' }, log, context);
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		const ran = await runWasm(uri('aborting.wasm'));
		assert.strictEqual(ran.exitCode, 134);
		assert.match(ran.stdout, /before/);
		assert.doesNotMatch(ran.stdout, /after/);
	});

	for (const mode of ['release', 'debug'] as const) {
		test(`C++ exceptions ${mode === 'debug' ? 'build' : 'work'} in ${mode}: catch by type, std::exception, rethrow, library throws, unwinding`, async () => {
			const nl = String.fromCharCode(10);
			const source = ['#include <cstdio>', '#include <stdexcept>', '#include <string>', '#include <vector>',
				'struct Guard { ~Guard() { std::puts("unwound"); } };',
				'static void thrower(int k) { Guard g; if (k == 1) throw 42; if (k == 2) throw std::runtime_error("boom"); }',
				'int main() {',
				'  try { thrower(1); } catch (int v) { std::printf("int %d\\n", v); }',
				'  try { thrower(2); } catch (const std::exception& e) { std::printf("what %s\\n", e.what()); }',
				'  try { try { thrower(2); } catch (...) { throw; } } catch (const std::runtime_error&) { std::puts("rethrown"); }',
				'  try { std::vector<int> v; (void)v.at(3); } catch (const std::out_of_range&) { std::puts("out_of_range"); }',
				'  try { (void)std::stoi("x"); } catch (const std::invalid_argument&) { std::puts("invalid_argument"); }',
				'  return 0;',
				'}', ''].join(nl);
			await write(`eh-${mode}.cpp`, source);
			const built = await build({ sources: [uri(`eh-${mode}.cpp`)], output: uri(`eh-${mode}.wasm`), flags: [], mode }, log, context);
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			if (mode === 'debug') { return; } // a debug build waits at startup for the debugger host, so only building is checked here
			const ran = await runWasm(uri(`eh-${mode}.wasm`));
			assert.strictEqual(ran.stdout, ['unwound', 'int 42', 'unwound', 'what boom', 'unwound', 'rethrown', 'out_of_range', 'invalid_argument', ''].join(nl));
			assert.strictEqual(ran.exitCode, 0);
		});
	}

	const NL = String.fromCharCode(10);
	async function buildAndRun(name: string, sources: Record<string, string>, flags: string[] = []) {
		for (const [file, text] of Object.entries(sources)) { await write(file, text); }
		const built = await build({ sources: Object.keys(sources).map(uri), output: uri(`${name}.wasm`), flags, mode: 'release' }, log, context);
		return { built, ran: built.exitCode === 0 ? await runWasm(uri(`${name}.wasm`)) : undefined };
	}

	for (const [label, body] of [
		['a noexcept function that throws', 'void f() noexcept { throw 1; }\nint main() { std::puts("before"); f(); std::puts("after"); }'],
		['a destructor that throws', 'struct D { ~D() { throw 1; } };\nint main() { std::puts("before"); { D d; } std::puts("after"); }'],
	] as const) {
		test(`C++ exceptions: ${label} reaches std::terminate (exit 134)`, async () => {
			const { built, ran } = await buildAndRun(`eh-terminate-${label.split(' ')[1]}`, { [`eh-terminate-${label.split(' ')[1]}.cpp`]: `#include <cstdio>\n${body}\n` });
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			assert.strictEqual(ran?.exitCode, 134);
			assert.match(ran?.stdout ?? '', /before/);
			assert.doesNotMatch(ran?.stdout ?? '', /after/);
		});
	}

	test('C++ exceptions: exception_ptr, nested_exception and a custom hierarchy caught by base reference', async () => {
		const { built, ran } = await buildAndRun('eh-advanced', { 'eh-advanced.cpp': [
			'#include <cstdio>', '#include <exception>', '#include <stdexcept>',
			'struct Base : std::exception { const char* what() const noexcept override { return "base"; } };',
			'struct Derived : Base { int code = 7; };',
			'static void inner() { throw std::logic_error("inner"); }',
			'static void outer() { try { inner(); } catch (...) { std::throw_with_nested(std::runtime_error("outer")); } }',
			'int main() {',
			'  std::exception_ptr p;',
			'  try { throw Derived(); } catch (...) { p = std::current_exception(); }',
			'  try { std::rethrow_exception(p); } catch (const Base& b) { std::printf("base %s\\n", b.what()); }',
			'  try { std::rethrow_exception(p); } catch (const Derived& d) { std::printf("derived %d\\n", d.code); }',
			'  try { outer(); } catch (const std::exception& e) {',
			'    std::printf("%s\\n", e.what());',
			'    try { std::rethrow_if_nested(e); } catch (const std::exception& n) { std::printf("nested %s\\n", n.what()); }',
			'  }',
			'  std::exception_ptr q = std::make_exception_ptr(42);',
			'  try { std::rethrow_exception(q); } catch (int v) { std::printf("ptr %d\\n", v); }',
			'  return 0;', '}', ''].join('\n') });
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		assert.strictEqual(ran?.stdout, ['base base', 'derived 7', 'outer', 'nested inner', 'ptr 42', ''].join(NL));
		assert.strictEqual(ran?.exitCode, 0);
	});

	for (const flags of [['-O2'], ['-O3', '-flto']]) {
		test(`C++ exceptions: a throw in one source file is caught in another, with ${flags.join(' ')}`, async () => {
			const { built, ran } = await buildAndRun(`eh-tu-${flags.join('')}`, {
				'eh-thrower.cpp': '#include <stdexcept>\nint thrower(int k) { if (k > 0) { throw std::out_of_range("tu"); } return k; }\n',
				'eh-main.cpp': ['#include <cstdio>', '#include <stdexcept>', 'int thrower(int);',
					'struct G { ~G() { std::puts("unwound"); } };',
					'int main() { try { G g; thrower(1); } catch (const std::out_of_range& e) { std::printf("caught %s\\n", e.what()); } return thrower(0); }', ''].join('\n'),
			}, flags);
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			assert.strictEqual(ran?.stdout, ['unwound', 'caught tu', ''].join(NL));
			assert.strictEqual(ran?.exitCode, 0);
		});
	}

	test('C++ exceptions: -fno-exceptions builds and runs a program without throw, and rejects one with it', async () => {
		const ok = await buildAndRun('eh-off-ok', { 'eh-off-ok.cpp': '#include <cstdio>\nint main() { std::puts("fine"); }\n' }, ['-fno-exceptions']);
		assert.strictEqual(ok.built.exitCode, 0, ok.built.diagnostics);
		assert.strictEqual(ok.ran?.stdout, `fine${NL}`);
		const bad = await buildAndRun('eh-off-bad', { 'eh-off-bad.cpp': 'int main() { throw 1; }\n' }, ['-fno-exceptions']);
		assert.notStrictEqual(bad.built.exitCode, 0);
		assert.match(bad.built.diagnostics, /exceptions/i);
	});

	for (const [label, body] of [
		['main()', 'int main() { std::puts("before"); throw 1; }'],
		['main(argc, argv)', 'int main(int, char**) { std::puts("before"); throw std::runtime_error("boom"); }'],
		['a std::exception from a nested call', 'void f() { throw std::logic_error("deep"); }\nint main() { std::puts("before"); f(); }'],
	] as const) {
		test(`C++ exceptions: an uncaught throw from ${label} prints its type and message, exit 134`, async function () {
			const name = `eh-uncaught-${label.replace(/\W+/g, '')}`;
			const { built } = await buildAndRun(name, { [`${name}.cpp`]: `#include <cstdio>
#include <stdexcept>
${body}
` });
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			const outcome = await Promise.race([runWasm(uri(`${name}.wasm`)), new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 8000))]);
			assert.notStrictEqual(outcome, 'hung', 'run() never settled');
			const ran = outcome as { exitCode: number; stderr: string };
			assert.strictEqual(ran.exitCode, 134, ran.stderr);
			assert.match(ran.stderr, label === 'main()' ? /uncaught exception of type int/ : /uncaught exception of type std::(runtime|logic)_error: (boom|deep)/);
		});
	}

	test('C++ exceptions: a throw in a static constructor ends as a crash (139) naming where it came from', async function () {
		const { built } = await buildAndRun('eh-static', { 'eh-static.cpp': '#include <cstdio>\nstruct S { S() { throw 1; } } s;\nint main() { std::puts("never"); }\n' });
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		const ran = await runWasm(uri('eh-static.wasm'));
		assert.strictEqual(ran.exitCode, 139, ran.stderr);
		assert.match(ran.stderr, /thrown outside main\(\)/);
		assert.doesNotMatch(ran.stdout, /never/);
	});

	test('a program that defines its own abort() keeps it', async () => {
		const nl = String.fromCharCode(10);
		await write('ownabort.cpp', ['#include <cstdlib>', '#include <wasi/api.h>', 'extern "C" void abort() { __wasi_proc_exit(7); }', 'int main() { std::abort(); }', ''].join(nl));
		const built = await build({ sources: [uri('ownabort.cpp')], output: uri('ownabort.wasm'), flags: [], mode: 'release' }, log, context);
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		assert.strictEqual((await runWasm(uri('ownabort.wasm'))).exitCode, 7);
	});

	test('default flags: signal emulation, C setjmp/longjmp and an 8 MiB stack need no user flags', async function () {
		this.timeout(60_000);
		const nl = String.fromCharCode(10);
		await write('defaults.c', ['#include <setjmp.h>', '#include <signal.h>', '#include <stdio.h>', 'static jmp_buf env;',
			'static int depth(int n) { volatile char pad[1024]; pad[0] = (char)n; return n == 0 ? 0 : pad[0] - pad[0] + 1 + depth(n - 1); }',
			'int main() { signal(SIGINT, SIG_IGN); if (setjmp(env) == 0) { longjmp(env, 1); } printf("%d", depth(4000)); return 0; }', ''].join(nl));
		const built = await build({ sources: [uri('defaults.c')], output: uri('defaults.wasm'), flags: [], mode: 'release' }, log, context);
		assert.strictEqual(built.exitCode, 0, built.diagnostics);
		const ran = await runWasm(uri('defaults.wasm'));
		assert.strictEqual(ran.exitCode, 0);
		assert.strictEqual(ran.stdout, '4000');
	});

	test('link flags reach wasm-ld, compile flags reach clang', async function () {
		this.timeout(30_000);
		await write('flags.cpp', FLAGS_SOURCE);
		const output = uri('flags.wasm');
		const result = await build({ sources: [uri('flags.cpp')], output, flags: ['-DANSWER=40', '-lm'], mode: 'release' }, log, context);
		assert.strictEqual(result.exitCode, 0, result.diagnostics);
		const run = await Promise.race([runWasm(output), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('run hung')), 10000))]);
		assert.strictEqual(run.stdout, '42');
		const bogus = await build({ sources: [uri('flags.cpp')], output: uri('bogus.wasm'), flags: ['-Wl,--no-such-linker-option'], mode: 'release' }, log, context);
		assert.notStrictEqual(bogus.exitCode, 0);
		assert.match(bogus.diagnostics, /wasm-ld: error: unknown argument.*no-such-linker-option/);
	});

	test('a tool that exceeds vscwclang.toolTimeoutSeconds is stopped with an error', async function () {
		this.timeout(60_000);
		await write('slow.cpp', 'int main() { return 0; }');
		const config = vscode.workspace.getConfiguration('vscwclang');
		await config.update('toolTimeoutSeconds', 0.05, vscode.ConfigurationTarget.Global);
		try {
			const result = await build({ sources: [uri('slow.cpp')], output: uri('slow.wasm'), flags: [], mode: 'release' }, log, context);
			assert.notStrictEqual(result.exitCode, 0);
			assert.match(result.diagnostics, /no result after 0\.05s.*toolTimeoutSeconds/);
		} finally {
			await config.update('toolTimeoutSeconds', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('a compile error is parsed with file, line and column', async () => {
		await write('bad.cpp', 'int main() {\n  return missing;\n}\n');
		const result = await build({ sources: [uri('bad.cpp')], output: uri('bad.wasm'), flags: [], mode: 'debug' }, log, context);
		assert.notStrictEqual(result.exitCode, 0);
		const errors = result.parsed.filter(d => d.severity === 'error');
		assert.strictEqual(errors.length, 1, JSON.stringify(result.parsed));
		assert.ok(errors[0].file?.endsWith('/bad.cpp'));
		assert.strictEqual(errors[0].line, 2);
	});

	test('onDiagnostics reports errors after the failing source, before later sources finish', async () => {
		await write('early-bad.cpp', 'int a() { return missing; }\n');
		await write('late-ok.cpp', 'int b() { return 0; }\n');
		const seen: number[] = [];
		const logged: string[] = [];
		const watch = { ...log, appendLine: (s: string) => { logged.push(s); log.appendLine(s); } } as vscode.OutputChannel;
		const result = await build({
			sources: [uri('early-bad.cpp'), uri('late-ok.cpp')], output: uri('early.wasm'), flags: [], mode: 'release',
			onDiagnostics: parsed => seen.push(parsed.filter(d => d.severity === 'error').length + logged.filter(l => l.includes('compiled') && l.includes('late-ok')).length * 100),
		}, watch, context);
		assert.notStrictEqual(result.exitCode, 0);
		assert.deepStrictEqual(seen, [1], 'one callback, with the error, before late-ok.cpp had finished compiling');
	});

	test('task provider offers build tasks and the problem matcher produces diagnostics', async function () {
		this.timeout(60_000);
		await vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'))?.activate();
		const tasks = await vscode.tasks.fetchTasks({ type: 'vscwclang' });
		assert.deepStrictEqual(tasks.map(t => t.name).sort(), ['build', 'build (debug)']);
		await write('tasked.cpp', 'int main() {' + String.fromCharCode(10) + '  return missing;' + String.fromCharCode(10) + '}' + String.fromCharCode(10));
		const release = tasks.find(t => t.name === 'build')!;
		const ended = new Promise<void>(resolve => { const d = vscode.tasks.onDidEndTask(e => { if (e.execution.task === release || e.execution.task.name === 'build') { d.dispose(); resolve(); } }); });
		await vscode.tasks.executeTask(release);
		await ended;
		// Matcher markers can carry a different URI scheme than the workspace folder (seen under test-web), so match by path.
		const errorsFor = () => vscode.languages.getDiagnostics().filter(([u]) => u.path.endsWith('/tasked.cpp')).flatMap(([, d]) => d).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
		let found = errorsFor();
		for (let i = 0; i < 30 && found.length === 0; i++) {
			await new Promise(r => setTimeout(r, 200));
			found = errorsFor();
		}
		assert.strictEqual(found.length, 1, JSON.stringify(vscode.languages.getDiagnostics().map(([u, d]) => [u.toString(), d.length])));
		assert.strictEqual(found[0].range.start.line, 1);
	});

	test('C_Cpp.default.* fallbacks are read from a registered, resource-scoped setting', async function () {
		const folder = vscode.workspace.workspaceFolders![0].uri;
		const cpp = vscode.workspace.getConfiguration('C_Cpp', folder);
		await cpp.update('default.defines', ['FROM_CPPTOOLS=3'], vscode.ConfigurationTarget.Workspace);
		try {
			assert.ok(userFlags().flags.includes('-DFROM_CPPTOOLS=3'), JSON.stringify(userFlags()));
		} finally {
			await cpp.update('default.defines', undefined, vscode.ConfigurationTarget.Workspace);
		}
	});

	test('a cppbuild task (as the C/C++ extension writes it) is mapped onto a build', async function () {
		this.timeout(60_000);
		await vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'))?.activate();
		await write('cppt.cpp', 'int main() {' + String.fromCharCode(10) + '  return gone;' + String.fromCharCode(10) + '}' + String.fromCharCode(10));
		// The workbench has no API to run a configured task by name, so resolve it with the provider as the workbench would.
		const definition = { type: 'cppbuild', label: 'C/C++: g++ build', command: '/usr/bin/g++', args: ['-fdiagnostics-color=always', '-g', 'cppt.cpp', '-o', 'cppt.exe'], options: { cwd: '${workspaceFolder}/build-test' } };
		const resolved = await createTaskProvider(context, log).resolveTask(new vscode.Task(definition, vscode.TaskScope.Workspace, 'C/C++: g++ build', 'cppbuild'), new vscode.CancellationTokenSource().token);
		assert.ok(resolved, 'provider did not resolve the cppbuild task');
		const ended = new Promise<void>(resolve => { const d = vscode.tasks.onDidEndTask(e => { if (e.execution.task.name === 'C/C++: g++ build') { d.dispose(); resolve(); } }); });
		await vscode.tasks.executeTask(resolved);
		await ended;
		const errorsFor = () => vscode.languages.getDiagnostics().filter(([u]) => u.path.endsWith('/build-test/cppt.cpp')).flatMap(([, d]) => d).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
		let found = errorsFor();
		for (let i = 0; i < 30 && found.length === 0; i++) {
			await new Promise(r => setTimeout(r, 200));
			found = errorsFor();
		}
		assert.strictEqual(found.length, 1, JSON.stringify(vscode.languages.getDiagnostics().map(([u, d]) => [u.toString(), d.length])));
		assert.strictEqual(found[0].range.start.line, 1);
	});

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', undefined, vscode.ConfigurationTarget.Global);
		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	});
});
