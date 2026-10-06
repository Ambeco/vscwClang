import * as assert from 'assert';
import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi';
import { build } from '../../toolchain/toolchain';

// Needs a workspace folder, --coi and ms-vscode.wasm-wasi-core (see the `test` script in package.json).
suite('vscwClang build (in browser)', function () {
	this.timeout(180_000);
	const encoder = new TextEncoder();
	const FLAGS_SOURCE = ['#include <cmath>', '#include <cstdio>', '#ifndef ANSWER', '#define ANSWER 40', '#endif',
		'int main() { std::printf("%d", ANSWER + (int)std::sqrt(4.0)); return 0; }', ''].join(String.fromCharCode(10));
	let context: vscode.ExtensionContext;
	let dir: vscode.Uri;
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
		context = { extensionUri: extension.extensionUri } as vscode.ExtensionContext;
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

	test('a compile error is parsed with file, line and column', async () => {
		await write('bad.cpp', 'int main() {\n  return missing;\n}\n');
		const result = await build({ sources: [uri('bad.cpp')], output: uri('bad.wasm'), flags: [], mode: 'debug' }, log, context);
		assert.notStrictEqual(result.exitCode, 0);
		const errors = result.parsed.filter(d => d.severity === 'error');
		assert.strictEqual(errors.length, 1, JSON.stringify(result.parsed));
		assert.ok(errors[0].file?.endsWith('/bad.cpp'));
		assert.strictEqual(errors[0].line, 2);
	});

	suiteTeardown(async () => {
		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	});
});
