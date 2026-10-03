import * as assert from 'assert';
import * as vscode from 'vscode';
import { build } from '../../toolchain/toolchain';

suite('vscwClang template', () => {
	test('toolchain stub fails loudly with a pointer to the plan', async () => {
		const log = vscode.window.createOutputChannel('vscwclang-test');
		await assert.rejects(
			build({ sources: [], output: vscode.Uri.parse('file:///a.wasm'), flags: [], mode: 'debug' }, log),
			/remaining_work\.md/);
	});

	test('build command is contributed', async () => {
		assert.ok((await vscode.commands.getCommands(true)).includes('vscwclang.build'));
	});
});
