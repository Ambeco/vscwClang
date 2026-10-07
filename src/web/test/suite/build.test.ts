import * as assert from 'assert';
import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { build } from '../../toolchain/toolchain';
import { ToolchainStore } from '../../toolchain/toolchainStore';

// Needs a workspace folder, --coi and ms-vscode.wasm-wasi-core (see the `test` script in package.json).
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

	async function runWasm(output: vscode.Uri): Promise<{ exitCode: number; stdout: string }> {
		const wasm = await Wasm.load();
		const module = await WebAssembly.compile(await vscode.workspace.fs.readFile(output) as Uint8Array<ArrayBuffer>);
		const process = await wasm.createProcess('prog', module, { stdio: { out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } } });
		let stdout = '';
		const decoder = new TextDecoder();
		process.stdout?.onData(d => { stdout += decoder.decode(d, { stream: true }); });
		return { exitCode: await process.run(), stdout };
	}

	suiteSetup(async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		dir = vscode.Uri.joinPath(folder, 'build-test');
		const extension = vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'));
		assert.ok(extension, 'vscwclang extension is not loaded');
		// The toolchain is served over HTTP from the extension dir (`npm run toolchain-dist`) and downloaded into a fresh storage dir.
		toolchainUrl = `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/dist`;
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

	test('multi-file project builds, links and runs', async () => {
		await write('util.h', '#pragma once\nint twice(int);\n');
		await write('util.cpp', '#include "util.h"\nint twice(int x) { return x * 2; }\n');
		await write('main.cpp', '#include <iostream>\n#include "util.h"\nint main() { std::cout << "hello " << twice(21) << std::endl; return 0; }\n');
		const output = uri('out.wasm');
		const result = await build({ sources: [uri('main.cpp'), uri('util.cpp')], output, flags: ['-std=c++20', '-Wall'], mode: 'release' }, log, context);
		assert.strictEqual(result.exitCode, 0, result.diagnostics);
		assert.deepStrictEqual(await runWasm(output), { exitCode: 0, stdout: 'hello 42\n' });
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

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', undefined, vscode.ConfigurationTarget.Global);
		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	});
});
