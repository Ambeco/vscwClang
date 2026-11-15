import * as assert from 'assert';
import * as vscode from 'vscode';
import { VscwClangDebugAdapter, type DebugHost, type ProgramTerminal } from '../../debug/debugAdapter';
import { build } from '../../toolchain/toolchain';
import { DapClient, type DapMessage } from './dapClient';

// Needs a workspace folder, --coi (see the `test` script in package.json), and the
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
		await vscode.workspace.getConfiguration('vscwclang').update('toolchainUrl', `${extension.extensionUri.toString().replace(/\/$/, '')}/llvm-artifacts/mtdist`, vscode.ConfigurationTarget.Global);
		context = { extensionUri: extension.extensionUri, globalStorageUri: vscode.Uri.joinPath(dir, 'storage') } as vscode.ExtensionContext;
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'main.cpp'), new TextEncoder().encode(SOURCE));
	});

	teardown(() => { adapters.forEach(a => a.dispose()); adapters = []; });

	/** An adapter whose "debug build" is a real `build()` of `source` in debug mode. */
	function newClient(source = 'main.cpp', host?: DebugHost, extraSources: string[] = []): DapClient {
		const output = vscode.Uri.joinPath(dir, `${source}.debug.wasm`);
		const plan = async () => {
			const built = await build({ sources: [source, ...extraSources].map(s => vscode.Uri.joinPath(dir, s)), output, flags: [], mode: 'debug' }, log, context);
			assert.strictEqual(built.exitCode, 0, built.diagnostics);
			return { output, args: [] };
		};
		const adapter = new VscwClangDebugAdapter({ workspaceFolder: { uri: folder } } as vscode.DebugSession, log, context, plan, host);
		adapters.push(adapter);
		const client = new DapClient(request => adapter.handleMessage(request as vscode.DebugProtocolMessage));
		adapter.onDidSendMessage(m => client.receive(m as unknown as DapMessage));
		return client;
	}

	const sourcePath = () => vscode.Uri.joinPath(dir, 'main.cpp').toString();

	test('builds in debug mode, stops at a breakpoint with a stack trace and values, steps, and runs to the exit code', async () => {
		const client = newClient();
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', { console: 'internalConsole' });
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

	test('steps line by line: over each statement of a function, skipping an untaken branch, then back into the caller', async () => {
		const client = newClient();
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', { console: 'internalConsole' });
		await client.event('initialized');
		await client.ok('setBreakpoints', { source: { path: sourcePath() }, breakpoints: [{ line: 3 }] });
		await client.ok('configurationDone');
		await client.event('stopped');
		const topLine = async () => ((await client.ok('stackTrace', { threadId: 1 })).stackFrames as { name: string; line: number }[])[0];
		assert.strictEqual((await topLine()).line, 3);
		const seen: number[] = [];
		for (let i = 0; i < 2; i++) {
			const before = client.events('stopped').length;
			await client.ok('next', { threadId: 1 });
			while (client.events('stopped').length === before) { await new Promise(r => setTimeout(r, 20)); }
			const top = await topLine();
			assert.match(top.name, /add/, JSON.stringify(top));
			seen.push(top.line);
		}
		assert.deepStrictEqual(seen, [4, 6], 'c = 11 does not take the if, so line 5 is skipped');
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
	});

	test('debugs a multithreaded program: a breakpoint in a thread function stops on that thread', async () => {
		const nl = String.fromCharCode(10);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'threaded.cpp'), new TextEncoder().encode([
			'#include <cstdio>', '#include <thread>',
			'static int result = 0;',
			'static void worker(int base) {',
			'  int doubled = base * 2;',
			'  if (doubled > 100)', // makes line 8 start a block, so it has a guard even without per-line guards
			'    doubled = 0;',
			'  result = doubled + 1;',
			'}',
			'int main() {',
			'  std::thread t(worker, 20);',
			'  t.join();',
			'  std::printf("result=%d\\n", result);',
			'  return result == 41 ? 0 : 1;',
			'}', ''].join(nl)));
		const client = newClient('threaded.cpp');
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', { console: 'internalConsole' });
		await client.event('initialized');
		const path = vscode.Uri.joinPath(dir, 'threaded.cpp').toString();
		const set = await client.ok('setBreakpoints', { source: { path }, breakpoints: [{ line: 8 }] });
		assert.strictEqual(set.breakpoints[0].verified, true, JSON.stringify(set));
		await client.ok('configurationDone');

		const stopped = (await client.event('stopped')).body;
		assert.strictEqual(stopped.reason, 'breakpoint');
		assert.notStrictEqual(stopped.threadId, 1, 'the worker runs on its own thread');
		assert.strictEqual(stopped.allThreadsStopped, true, 'a threaded debug build stops every thread');
		const threads = (await client.ok('threads')).threads as { id: number; name: string }[];
		assert.ok(threads.some(t => t.id === stopped.threadId) && threads.some(t => t.id === 1), JSON.stringify(threads));
		// main is blocked in join(), which is not an instrumented statement, so it is listed as still running without a stack.
		assert.match(threads.find(t => t.id === 1)!.name, /^main( \(still running.*\))?$/, JSON.stringify(threads));
		const frames = (await client.ok('stackTrace', { threadId: stopped.threadId })).stackFrames as { name: string; line: number }[];
		assert.match(frames[0].name, /worker/, JSON.stringify(frames));
		assert.strictEqual(frames[0].line, 8);
		const doubled = (await client.ok('evaluate', { expression: 'doubled', frameId: 1, context: 'hover' })).result as string;
		assert.match(doubled, /\(int\) doubled = 40/);

		await client.ok('continue', { threadId: stopped.threadId });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
		await client.event('terminated');
		assert.strictEqual(client.events('output').filter(m => m.body.category === 'stdout').map(m => m.body.output).join(''), 'result=41\n');
	});

	const INPUT_SOURCE = [
		'#include <iostream>',
		'static int twice(int v) {',
		'  int r = v * 2;',
		'  return r;',
		'}',
		'int main() {',
		'  int n = 0;',
		'  std::cout << "n? " << std::flush;',
		'  std::cin >> n;',
		'  std::cout << "got " << twice(n) << std::endl;',
		'  return 0;',
		'}',
		'',
	].join(String.fromCharCode(10));

	/** Opens the debug terminal as VS Code would, collecting what it shows. */
	function terminalHost(): { host: DebugHost; screen: () => string; type: (keys: string) => void; waitFor: (needle: string) => Promise<void> } {
		let pty: ProgramTerminal | undefined;
		let screen = '';
		const host: DebugHost = { openTerminal: p => { pty = p; p.onDidWrite(t => { screen += t; }); p.open(); } };
		const waitFor = async (needle: string) => {
			for (let i = 0; i < 600 && !screen.includes(needle); i++) { await new Promise(r => setTimeout(r, 50)); }
			assert.ok(screen.includes(needle), `terminal never showed ${JSON.stringify(needle)}; it shows ${JSON.stringify(screen)}`);
		};
		return { host, screen: () => screen, type: keys => pty!.handleInput(keys), waitFor };
	}

	test('Debug runs the program in a terminal: input typed after its prompt reaches std::cin, with a breakpoint after the read', async () => {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'input.cpp'), new TextEncoder().encode(INPUT_SOURCE));
		const terminal = terminalHost();
		const client = newClient('input.cpp', terminal.host);
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', {});
		await client.event('initialized');
		const set = await client.ok('setBreakpoints', { source: { path: vscode.Uri.joinPath(dir, 'input.cpp').toString() }, breakpoints: [{ line: 3 }] });
		assert.strictEqual(set.breakpoints[0].verified, true, JSON.stringify(set));
		await client.ok('configurationDone');
		await terminal.waitFor('n? ');
		terminal.type('21\r');
		assert.strictEqual((await client.event('stopped')).body.reason, 'breakpoint');
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
		await terminal.waitFor('got 42');
		assert.ok(terminal.screen().includes('n? 21\r\n'), `typed text is echoed beside the prompt: ${JSON.stringify(terminal.screen())}`);
		assert.deepStrictEqual(client.events('output').filter(m => m.body.category === 'stdout'), [], 'program output is in the terminal, not the Debug Console');
	});

	test('Debug: a line typed while the program is held at startup, and one typed at a breakpoint stop, both reach the program in order', async () => {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'input.cpp'), new TextEncoder().encode(INPUT_SOURCE));
		const terminal = terminalHost();
		const client = newClient('input.cpp', terminal.host);
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', {});
		await client.event('initialized');
		terminal.type('5\r'); // before configurationDone: the stub is waiting for its first command and hands this back
		const set = await client.ok('setBreakpoints', { source: { path: vscode.Uri.joinPath(dir, 'input.cpp').toString() }, breakpoints: [{ line: 7 }] });
		assert.strictEqual(set.breakpoints[0].verified, true, JSON.stringify(set));
		await client.ok('configurationDone');
		assert.strictEqual((await client.event('stopped')).body.reason, 'breakpoint'); // main's first block, before the prompt and the read
		terminal.type('9\r'); // typed at the stop: waits for the resume, after the 5
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
		await terminal.waitFor('got 10');
	});

	test('debugs a multi-file program: a breakpoint in the second file reports that file, with the caller in the first', async () => {
		const nl = String.fromCharCode(10);
		const write = (name: string, lines: string[]) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), new TextEncoder().encode(lines.join(nl)));
		await write('multi_main.cpp', ['int triple(int x);', 'int main() {', '  int r = triple(14);', '  return r == 42 ? 0 : 1;', '}', '']);
		await write('multi_lib.cpp', ['int triple(int x) {', '  int y = x * 3;', '  if (y > 1000)', '    y = 0;', '  return y;', '}', '']);
		const client = newClient('multi_main.cpp', undefined, ['multi_lib.cpp']);
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', { console: 'internalConsole' });
		await client.event('initialized');
		const libPath = vscode.Uri.joinPath(dir, 'multi_lib.cpp').toString();
		const set = await client.ok('setBreakpoints', { source: { path: libPath }, breakpoints: [{ line: 5 }] });
		assert.strictEqual(set.breakpoints[0].verified, true, JSON.stringify(set));
		await client.ok('configurationDone');
		assert.strictEqual((await client.event('stopped')).body.reason, 'breakpoint');
		const frames = (await client.ok('stackTrace', { threadId: 1 })).stackFrames as { id: number; name: string; line: number; source?: { name: string; path?: string } }[];
		assert.match(frames[0].name, /triple/, JSON.stringify(frames));
		assert.strictEqual(frames[0].source?.name, 'multi_lib.cpp');
		assert.strictEqual(frames[0].source?.path, libPath);
		const caller = frames.find(f => /main/.test(f.name));
		assert.ok(caller, JSON.stringify(frames));
		assert.strictEqual(caller.source?.name, 'multi_main.cpp');
		const y = (await client.ok('evaluate', { expression: 'y', frameId: frames[0].id, context: 'hover' })).result as string;
		assert.match(y, /\(int\) y = 42\b/);
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
	});

	test('debugs a program that throws and catches: a breakpoint in the handler stops, and the run ends normally', async () => {
		const nl = String.fromCharCode(10);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'throws.cpp'), new TextEncoder().encode([
			'#include <cstdio>', '#include <stdexcept>',
			'static int risky(int n) {',
			'  if (n > 2)',
			'    throw std::runtime_error("too big");',
			'  return n;',
			'}',
			'int main() {',
			'  int caught = 0;',
			'  try {',
			'    risky(5);',
			'  } catch (const std::exception& e) {',
			'    caught = 7;',
			'    std::printf("caught: %s\\n", e.what());',
			'  }',
			'  return caught == 7 ? 0 : 1;',
			'}', ''].join(nl)));
		const client = newClient('throws.cpp');
		await client.ok('initialize', { adapterID: 'vscwclang' });
		await client.ok('launch', { console: 'internalConsole' });
		await client.event('initialized');
		const path = vscode.Uri.joinPath(dir, 'throws.cpp').toString();
		const set = await client.ok('setBreakpoints', { source: { path }, breakpoints: [{ line: 5 }, { line: 14 }] });
		assert.deepStrictEqual(set.breakpoints.map((b: { verified: boolean }) => b.verified), [true, true], JSON.stringify(set));
		await client.ok('configurationDone');
		const topLine = async () => ((await client.ok('stackTrace', { threadId: 1 })).stackFrames as { name: string; line: number }[])[0];
		await client.event('stopped');
		assert.match((await topLine()).name, /risky/);
		assert.strictEqual((await topLine()).line, 5);
		await client.ok('continue', { threadId: 1 });
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 30_000;
			const seen = () => JSON.stringify(['stopped', 'exited', 'terminated'].map(e => [e, client.events(e).map(m => m.body)]).concat([['output', client.events('output').map(m => m.body.output)]]));
			const poll = () => client.events('stopped').length >= 2 ? resolve()
				: client.events('exited').length > 0 ? reject(new Error(`the program exited without stopping in the catch handler: ${seen()}`))
				: Date.now() > deadline ? reject(new Error(`no stop in the catch handler: ${seen()}`)) : void setTimeout(poll, 20);
			poll();
		});
		const handler = await topLine();
		assert.match(handler.name, /main/, JSON.stringify(handler));
		assert.strictEqual(handler.line, 14, 'stopped in the catch handler after the unwind');
		await client.ok('continue', { threadId: 1 });
		assert.strictEqual((await client.event('exited')).body.exitCode, 0);
		assert.ok(client.events('output').some(m => m.body.category === 'stdout' && /caught: too big/.test(m.body.output)));
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
