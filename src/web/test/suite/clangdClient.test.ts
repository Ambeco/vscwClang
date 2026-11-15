import * as assert from 'assert';
import * as vscode from 'vscode';
import { startClangdClient } from '../../clangd/clangdClient';
import { TOOLCHAIN_SCHEME } from '../../toolchain/guestPaths';

/**
 * Verifies the wired-up client (`src/web/clangd/clangdClient.ts`), as opposed to `clangd.test.ts`, which drives
 * its own raw clangd.wasm process directly over the pipe to test the host integration. This one checks that VS
 * Code's own diagnostics surface, i.e. that the `LanguageClient` actually works end to end.
 *
 * Starts its own client (its own `ExtensionContext`-shaped storage dir, its own toolchain-url override) rather
 * than relying on the one `extension.ts` starts at activation: that one runs once, before any suite, with the
 * default (CDN) `toolchainUrl` and the real (possibly read-only, in the test harness) `globalStorageUri`, so
 * nothing here could configure it in time anyway. The fixture workspace's `.vscode/settings.json` turns the
 * activation client off, because two live clients collide on the server's command ids.
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
		const toolchainUrl = `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/mtdist`;
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', toolchainUrl, vscode.ConfigurationTarget.Global);
		const context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		try {
			disposable = await startClangdClient(context, log, { ignoreIntelliSenseSetting: true });
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
			'-isystem/sysroot/include/wasm32-wasip1/eh/c++/v1', '-isystem/sysroot/include/c++/v1', '-fwasm-exceptions', '-std=c++20'];
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

	test('go-to-definition into a /sysroot header opens it through the read-only toolchain scheme', async () => {
		const text = ['#include <cstdio>', 'int main() { return std::puts("x"); }', ''].join(String.fromCharCode(10));
		await write('sysdef.cpp', text);
		const file = vscode.Uri.joinPath(dir, 'sysdef.cpp');
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
		const position = new vscode.Position(1, text.split(String.fromCharCode(10))[1].indexOf('puts') + 1);
		const deadline = Date.now() + 40_000;
		let found: vscode.Location | undefined;
		while (Date.now() < deadline && !found) {
			const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', file, position) ?? [];
			const first = defs[0];
			found = first && 'uri' in first ? first : undefined;
			if (!found) { await new Promise(r => setTimeout(r, 500)); }
		}
		assert.ok(found, 'clangd returned no definition for std::puts');
		assert.strictEqual(found.uri.scheme, TOOLCHAIN_SCHEME, found.uri.toString());
		assert.ok(found.uri.path.startsWith('/sysroot/'), found.uri.path);
		const opened = await vscode.workspace.openTextDocument(found.uri);
		assert.ok(opened.getText().includes('puts'), `no puts in ${found.uri.toString()} (${opened.getText().length} chars)`);
		await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(found.uri, encoder.encode('x'))), /read-only/);
	});
	const NL = String.fromCharCode(10);
	const SRC = ['int main(){', 'int a=1;', 'return a;', '}', ''].join(NL);
	const formatted = async (name: string, text: string) => {
		await write(name, text);
		const file = vscode.Uri.joinPath(dir, name);
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
		const deadline = Date.now() + 40_000;
		let edits: vscode.TextEdit[] = [];
		while (Date.now() < deadline && edits.length === 0) {
			edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', file, { tabSize: 4, insertSpaces: true }) ?? [];
			if (edits.length === 0) { await new Promise(r => setTimeout(r, 500)); }
		}
		const edit = new vscode.WorkspaceEdit();
		edit.set(file, edits);
		await vscode.workspace.applyEdit(edit);
		return (await vscode.workspace.openTextDocument(file)).getText();
	};

	test('Format Document uses the fallback style (Microsoft, 4 spaces) when there is no .clang-format file', async () => {
		const out = await formatted('fmt-fallback.cpp', SRC);
		assert.ok(out.includes(NL + '    return a;'), JSON.stringify(out));
	});

	test('Format Document follows a .clang-format file that exists before the first format', async () => {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'styled'));
		await write('styled/.clang-format', ['BasedOnStyle: LLVM', 'IndentWidth: 8', ''].join(NL));
		const out = await formatted('styled/fmt-file.cpp', SRC);
		assert.ok(out.includes(NL + '        return a;'), JSON.stringify(out));
	});

	test('Format Document follows a .clang-format file changed after clangd formatted a file there', async () => {
		await write('styled/.clang-format', ['BasedOnStyle: LLVM', 'IndentWidth: 3', ''].join(NL));
		const out = await formatted('styled/fmt-file2.cpp', SRC);
		assert.ok(out.includes(NL + '   return a;'), JSON.stringify(out));
	});
});
