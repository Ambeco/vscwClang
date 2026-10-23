import * as assert from 'assert';
import * as vscode from 'vscode';
import { runProgram } from '../../runProgram';

/**
 * Run on the V2 Worker host (`vscwclang.experimental.workerHost`) with prebuilt fixtures (src/web/test/fixtures/host,
 * rebuilt by scripts/build-host-fixtures.mjs). Needs a workspace folder and --coi (see the `test` script in package.json).
 */
suite('vscwClang Run on the Worker host (in browser)', function () {
	this.timeout(60_000);
	let context: vscode.ExtensionContext;
	let dir: vscode.Uri;
	let extension: vscode.Extension<unknown>;

	suiteSetup(async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		dir = vscode.Uri.joinPath(folder, 'worker-host-test');
		extension = (vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang')))!;
		assert.ok(extension, 'vscwclang extension is not loaded');
		context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		await vscode.workspace.getConfiguration('vscwclang').update('experimental.workerHost', true, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('vscwclang').update('experimental.workerHost', undefined, vscode.ConfigurationTarget.Global);
	});

	async function install(fixture: string): Promise<vscode.Uri> {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'src', 'web', 'test', 'fixtures', 'host', `${fixture}.wasm`));
		const target = vscode.Uri.joinPath(dir, `${fixture}.wasm`);
		await vscode.workspace.fs.writeFile(target, bytes);
		return target;
	}

	type Typer = { handleInput?(data: string): void };

	/** Runs a fixture in a recording terminal; `onOpen` and `onOutput` can type input into it. */
	async function runFixture(fixture: string, args: string[] = [], hooks: { onOpen?: (pty: Typer) => void; onOutput?: (text: string, pty: Typer) => void } = {}): Promise<{ exitCode: number; text: string }> {
		const wasmFile = await install(fixture);
		let text = '';
		const exitCode = await Promise.race([
			runProgram(context, wasmFile, args, {
				openTerminal: pty => {
					pty.onDidWrite(d => { text += d; hooks.onOutput?.(text, pty); });
					pty.open(undefined);
					hooks.onOpen?.(pty);
				},
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`run hung; output so far: ${JSON.stringify(text)}`)), 20_000)),
		]);
		return { exitCode, text };
	}

	test('output, arguments and the exit code reach the terminal', async () => {
		const ran = await runFixture('hello', ['a', 'b']);
		assert.strictEqual(ran.exitCode, 3);
		assert.ok(ran.text.includes('hello a b\r\n'), ran.text);
		assert.ok(ran.text.includes('to-stderr'), ran.text);
		assert.ok(ran.text.includes('[hello.wasm exited with code 3]'), ran.text);
	});

	test('typed lines are echoed and delivered to the program', async () => {
		let quit = false;
		const ran = await runFixture('echo', [], {
			onOpen: pty => { setTimeout(() => pty.handleInput!('hi\r'), 200); },
			onOutput: (text, pty) => { if (!quit && text.includes('got: hi')) { quit = true; pty.handleInput!('quit\r'); } },
		});
		assert.strictEqual(ran.exitCode, 0);
		assert.ok(ran.text.includes('got: hi'), ran.text);
		assert.ok(ran.text.includes('bye'), ran.text);
	});

	test('files written under /workspace land in the workspace folder', async () => {
		const ran = await runFixture('fileio');
		assert.strictEqual(ran.exitCode, 0, ran.text);
		const saved = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'out.txt')));
		assert.strictEqual(saved, 'line one\nline two\nline three\n');
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'out.txt'));
	});

	for (const [mode, message] of [['oob', /out of bounds/], ['div', /divide by zero/], ['trap', /unreachable/]] as const) {
		test(`a "${mode}" crash ends the run with a message instead of hanging`, async () => {
			const ran = await runFixture('trap', [mode]);
			assert.strictEqual(ran.exitCode, 139);
			assert.ok(ran.text.includes('before'), ran.text);
			assert.match(ran.text, message);
			assert.ok(ran.text.includes('trapped'), ran.text);
		});
	}

	test('Ctrl+C stops a program that is waiting for input', async () => {
		const ran = await runFixture('echo', [], { onOpen: pty => { setTimeout(() => pty.handleInput!('\u0003'), 300); } });
		assert.strictEqual(ran.exitCode, 130);
		assert.ok(ran.text.includes('[echo.wasm terminated]'), ran.text);
	});
});
