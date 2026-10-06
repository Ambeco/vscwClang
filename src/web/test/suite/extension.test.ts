import * as assert from 'assert';
import * as vscode from 'vscode';
import { build } from '../../toolchain/toolchain';

suite('vscwClang template', () => {
	const dummyContext = {} as vscode.ExtensionContext;

	test('build rejects an empty source list with a did-you-mean', async () => {
		const log = vscode.window.createOutputChannel('vscwclang-test');
		await assert.rejects(
			build({ sources: [], output: vscode.Uri.parse('file:///a.wasm'), flags: [], mode: 'debug' }, log, dummyContext),
			/no source files.*Did you mean/);
	});

	test('build rejects restricted flags before touching the toolchain', async () => {
		const log = vscode.window.createOutputChannel('vscwclang-test');
		await assert.rejects(
			build({ sources: [vscode.Uri.parse('file:///a.cpp')], output: vscode.Uri.parse('file:///a.wasm'), flags: ['-fuse-ld=gold'], mode: 'debug' }, log, dummyContext),
			/-fuse-ld=gold.*Did you mean/s);
	});

	test('build command is contributed', async () => {
		await vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'))?.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('vscwclang.build') && commands.includes('vscwclang.run'));
	});
});
