import * as assert from 'assert';
import * as vscode from 'vscode';
import { VscwClangDebugAdapter } from '../../debug/debugAdapter';
import { build } from '../../toolchain/toolchain';
import { DapClient, type DapMessage } from './dapClient';

// Needs a workspace folder, --coi and ms-vscode.wasm-wasi-core (see the `test` script in package.json), and the
// local toolchain dist with the lldb reactor (`npm run pretest` builds it from llvm-artifacts/).
suite('vscwClang debug adapter (in browser)', function () {
	this.timeout(240_000);
	const SOURCE = [
		'#include <cstdio>',
		'static int add(int a, int b) {',
		'  int c = a + b;',
		'  if (c > 100)',
		'    c = 0;',
		'  return c;',
		'}',
		'int main() {',
		'  int r = add(1, 10);',
		'  if (r != 11) { std::puts("bad"); return 1; }', // gives main a block after the call, for step out to stop in
		'  std::printf("r=%d\\n", r);',
		'  return 0;',
		'}',
		'',
	].join(String.fromCharCode(10));
	const log = vscode.window.createOutputChannel('vscwclang-debug-test');
	let folder: vscode.Uri;
	let dir: vscode.Uri;
	let context: vscode.ExtensionContext;
	let adapters: VscwClangDebugAdapter[] = [];

	suiteSetup(async () => {
		folder = vscode.workspace.workspaceFolders![0].uri;
		dir = vscode.Uri.joinPath(folder, 'debug-test');
		const extension = vscode.extensions.all.find(e => e.id.endsWith('.vscwclang'));
		assert.ok(extension, 'vscwclang extension is not loaded');
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/dist`, vscode.ConfigurationTarget.Global);
		context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'main.cpp'), new TextEncoder().encode(SOURCE));
	});

	teardown(() => { adapters.forEach(a => a.dispose()); adapters = []; });

	/** An adapter whose "debug build" is a real `build()` of main.cpp in debug mode. */
	function newClient(): DapClient {
		const output = vscode.Uri.joinPath(dir, 'main.debug.wasm');
		const plan = async () => {
			const built = await build({ sources: [vscode.Uri.joinPath(dir, 'main.cpp')], output, flags: [], mode: 'debug' }, log, context);
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			return { output, args: [] };
		};
		const adapter = new VscwClangDebugAdapter({ workspaceFolder: { uri: folder } } as vscode.DebugSession, log, context, plan);
		adapters.push(adapter);
		const client = new DapClient(request => adapter.handleMessage(request as vscode.DebugProtocolMessage));
		adapter.onDidSendMessage(m => client.receive(m as unknown as DapMessage));
		return client;
	}

	const sourcePath = () => vscode.Uri.joinPath(dir, 'main.cpp').toString();

	test('builds in debug mode, stops at a breakpoint with a stack trace and values, steps, and runs to the exit code', async () => {
		const client = newClient();
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', {});
		await client.event('initialized');
		const set = await client.ok('setBreakpoints', { source: { path: sourcePath() }, breakpoints: [{ line: 6 }] });
		assert.strictEqual(set.breakpoints[0].verified, true, JSON.stringify(set));
		await client.ok('configurationDone');

		assert.strictEqual((await client.event('stopped')).body.reason, 'breakpoint');
		const frames = (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { id: number; name: string; line: number; source?: { name: string; path?: string } }[];
		assert.match(frames[0].name, /add/, JSON.stringify(frames));
		assert.ok(frames.some(f => /main/.test(f.name)), JSON.stringify(frames));
		assert.strictEqual(frames[0].source?.name, 'main.cpp');
		assert.strictEqual(frames[0].source?.path, sourcePath(), 'the client gets its own URI form back');
		const value = async (expression: string) => (await client.ok('evaluate', { expression, frameId: frames[0].id, context: 'hover' })).result as string;
		assert.match(await value('a'), /\(int\) a = 1\b/);
		assert.match(await value('b'), /\(int\) b = 10\b/);
		assert.match(await value('c'), /\(int\) c = 11\b/);

		await client.ok('stepOut', { threadId: 1 });
		await client.event('stopped');
		const outer = (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { name: string }[];
		assert.ok(/main/.test(outer[0].name), `stepped out into main: ${JSON.stringify(outer)}`);

		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
		await client.event('terminated');
		assert.strictEqual(client.events('output').filter(m => m.body.category === 'stdout').map(m => m.body.output).join(''), 'r=11\n');
	});

	test('a program that fails to build reports the failure and ends the launch', async () => {
		const bad = vscode.Uri.joinPath(dir, 'bad.cpp');
		await vscode.workspace.fs.writeFile(bad, new TextEncoder().encode('int main() { return missing(); }\n'));
		const output = vscode.Uri.joinPath(dir, 'bad.debug.wasm');
		const adapter = new VscwClangDebugAdapter({ workspaceFolder: { uri: folder } } as vscode.DebugSession, log, context, async () => {
			const built = await build({ sources: [bad], output, flags: [], mode: 'debug' }, log, context);
			return built.exitCode === 0 ? { output, args: [] } : undefined;
		});
		adapters.push(adapter);
		const client = new DapClient(request => adapter.handleMessage(request as vscode.DebugProtocolMessage));
		adapter.onDidSendMessage(m => client.receive(m as unknown as DapMessage));
		await client.ok('initialize');
		const launch = await client.request('launch', {});
		assert.strictEqual(launch.success, false);
		assert.match(launch.message!, /debug build failed or was cancelled/);
	});
});
