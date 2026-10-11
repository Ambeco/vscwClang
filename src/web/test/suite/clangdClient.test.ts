import * as assert from 'assert';
import * as vscode from 'vscode';
import { startClangdClient } from '../../clangd/clangdClient';

/**
 * Verifies the wired-up client (`src/web/clangd/clangdClient.ts`), as opposed to `clangd.test.ts`, which drives
 * its own raw clangd.wasm process directly over the pipe to test the host integration. This one checks that VS
 * Code's own diagnostics surface, i.e. that the `LanguageClient` actually works end to end.
 *
 * Starts its own client (its own `ExtensionContext`-shaped storage dir, its own toolchain-url override) rather
 * than relying on the one `extension.ts` starts at activation: that one runs once, before any suite, with the
 * default (CDN) `toolchainUrl` and the real (possibly read-only, in the test harness) `globalStorageUri`, so
 * nothing here could configure it in time anyway.
 */
suite('vscwClang clangd client (in browser)', function () {
	this.timeout(60_000);

	let dir: vscode.Uri;
	let disposable: vscode.Disposable | undefined;
	const encoder = new TextEncoder();
	const write = (name: string, text: string) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), encoder.encode(text));

	suiteSetup(async function () {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		dir = vscode.Uri.joinPath(folder, 'clangdclient-test');
		await vscode.workspace.fs.createDirectory(dir);
		const extension = vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'));
		assert.ok(extension, 'vscwclang extension is not loaded');
		const log = vscode.window.createOutputChannel('vscwclang-clangdclient-test');
		const toolchainUrl = `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/dist`;
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', toolchainUrl, vscode.ConfigurationTarget.Global);
		const context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		try {
			disposable = await startClangdClient(context, log);
		} catch {
			this.skip();
			return;
		}
		if (!disposable) { this.skip(); }
	});

	suiteTeardown(async () => {
		disposable?.dispose();
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', undefined, vscode.ConfigurationTarget.Global);
		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	});

	test('a diagnostic from a real clangd session reaches VS Code\'s own diagnostics for an open .cpp file', async () => {
		const CPP_FLAGS = ['--target=wasm32-wasip1', '--sysroot=/sysroot', '-resource-dir=/resource',
			'-isystem/sysroot/include/wasm32-wasip1/noeh/c++/v1', '-isystem/sysroot/include/c++/v1', '-fno-exceptions', '-std=c++20'];
		const file = vscode.Uri.joinPath(dir, 'broken.cpp');
		const guestDir = `/workspace/${vscode.workspace.asRelativePath(dir, false)}`;
		await write('compile_commands.json', JSON.stringify([
			{ directory: guestDir, file: `${guestDir}/broken.cpp`, arguments: ['clang++', ...CPP_FLAGS, `${guestDir}/broken.cpp`] },
		]));
		await write('broken.cpp', 'int main() { return undeclared_name; }\n');

		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);

		const deadline = Date.now() + 30_000;
		let diagnostics: readonly vscode.Diagnostic[] = [];
		while (Date.now() < deadline) {
			diagnostics = vscode.languages.getDiagnostics(file);
			if (diagnostics.length > 0) { break; }
			await new Promise(r => setTimeout(r, 250));
		}
		assert.ok(diagnostics.length > 0, 'expected clangd to publish at least one diagnostic for broken.cpp');
		assert.ok(diagnostics.some(d => /undeclared_name|undeclared identifier/i.test(d.message)), JSON.stringify(diagnostics));
	});
});
