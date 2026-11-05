import * as assert from 'assert';
import * as vscode from 'vscode';
import { runProgram } from '../../runProgram';

/**
 * Run on the Wasmer host with the prebuilt fixtures of workerHost.test.ts. Needs the Wasmer SDK served from the
 * extension folder: copy `dist/`, `pkg/` and `LICENSE` of `node_modules/@wasmer/sdk` (from `npm install @wasmer/sdk`
 * in a scratch folder) to `llvm-artifacts/wasmer-sdk/`. Skipped when it is missing.
 */
suite('vscwClang Run on the Wasmer host (in browser)', function () {
	this.timeout(90_000);
	let context: vscode.ExtensionContext;
	let dir: vscode.Uri;
	let extension: vscode.Extension<unknown>;
	let available = false;

	suiteSetup(async function () {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		extension = (vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang')))!;
		assert.ok(extension, 'vscwclang extension is not loaded');
		const sdk = vscode.Uri.joinPath(extension.extensionUri, 'llvm-artifacts', 'wasmer-sdk');
		try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(sdk, 'dist', 'index.js')); available = true; } catch { available = false; }
		if (!available) { this.skip(); }
		dir = vscode.Uri.joinPath(folder, 'wasmer-host-test');
		context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		await vscode.workspace.getConfiguration('vscwclang').update('wasmerSdkUrl', sdk.toString(), vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration('vscwclang').update('run.host', 'wasmer', vscode.ConfigurationTarget.Workspace);
	});

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('vscwclang').update('run.host', undefined, vscode.ConfigurationTarget.Workspace);
		await vscode.workspace.getConfiguration('vscwclang').update('wasmerSdkUrl', undefined, vscode.ConfigurationTarget.Global);
	});

	async function install(fixture: string): Promise<vscode.Uri> {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'src', 'web', 'test', 'fixtures', 'host', `${fixture}.wasm`));
		const target = vscode.Uri.joinPath(dir, `${fixture}.wasm`);
		await vscode.workspace.fs.writeFile(target, bytes);
		return target;
	}

	type Typer = { handleInput?(data: string): void };

	async function runFixture(fixture: string, args: string[] = [], hooks: { onOpen?: (pty: Typer) => void; onOutput?: (text: string, pty: Typer) => void } = {}): Promise<{ exitCode: number; text: string }> {
		const wasmFile = await install(fixture);
		let text = '';
		const exitCode = await Promise.race([
			runProgram(context, wasmFile, args, {
				openTerminal: pty => {
					pty.onDidWrite(d => { text += d; hooks.onOutput?.(text, pty); });
					pty.open();
					hooks.onOpen?.(pty);
				},
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`run hung; output so far: ${JSON.stringify(text)}`)), 60_000)),
		]);
		return { exitCode, text };
	}

	test('a missing SDK URL fails with a did-you-mean instead of falling back to the Worker host', async () => {
		const config = vscode.workspace.getConfiguration('vscwclang');
		const url = config.get<string>('wasmerSdkUrl');
		await config.update('wasmerSdkUrl', '', vscode.ConfigurationTarget.Global);
		try {
			await assert.rejects(() => runFixture('hello'), /wasmerSdkUrl is empty.*run\.host back to "worker"/);
		} finally {
			await config.update('wasmerSdkUrl', url, vscode.ConfigurationTarget.Global);
		}
	});

	test('output, arguments and the exit code reach the terminal', async () => {
		const ran = await runFixture('hello', ['a', 'b']);
		assert.strictEqual(ran.exitCode, 3);
		assert.ok(ran.text.includes('hello a b'), ran.text);
		assert.ok(ran.text.includes('to-stderr'), ran.text);
		assert.ok(ran.text.includes('[hello.wasm exited with code 3]'), ran.text);
	});

	test('typed lines are echoed and delivered to the program', async () => {
		let quit = false;
		const ran = await runFixture('echo', [], {
			onOpen: pty => { setTimeout(() => pty.handleInput!('hi\r'), 5000); },
			onOutput: (text, pty) => { if (!quit && text.includes('got: hi')) { quit = true; pty.handleInput!('quit\r'); } },
		});
		assert.strictEqual(ran.exitCode, 0);
		assert.ok(ran.text.includes('got: hi'), ran.text);
		assert.ok(ran.text.includes('bye'), ran.text);
	});

	test('files written under /workspace are copied back to the workspace folder', async () => {
		const ran = await runFixture('fileio');
		assert.strictEqual(ran.exitCode, 0, ran.text);
		const out = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'out.txt');
		assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(out)), 'line one\nline two\nline three\n');
		await vscode.workspace.fs.delete(out);
	});

	test('a crash ends the run with the engine message and exit code 139', async () => {
		const ran = await runFixture('trap', ['div']);
		assert.strictEqual(ran.exitCode, 139);
		assert.ok(ran.text.includes('before'), ran.text);
		assert.match(ran.text, /divide by zero/);
	});

	test('a threaded program runs', async () => {
		const ran = await runFixture('threads');
		assert.strictEqual(ran.exitCode, 0, ran.text);
		assert.ok(ran.text.includes('counter = 4000'), ran.text);
	});

	test('Ctrl+C stops a program that is waiting for input', async () => {
		const ran = await runFixture('echo', [], { onOpen: pty => { setTimeout(() => pty.handleInput!('\u0003'), 8000); } });
		assert.strictEqual(ran.exitCode, 130);
		assert.ok(ran.text.includes('[echo.wasm terminated]'), ran.text);
	});
});
