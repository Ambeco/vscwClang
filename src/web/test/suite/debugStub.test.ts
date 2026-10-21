import * as assert from 'assert';
import * as vscode from 'vscode';
import { Wasm, type WasmProcess } from '@vscode/wasm-wasi';
import { PAGE_SIZE } from '../../debug/pagedMemory';
import { StubSession } from '../../debug/stubChannel';
import { scanProgram } from '../../debug/wasmScan';
import { describeUnsupportedImports } from '../../toolchain/wasiImports';

/**
 * Spike: does the in-process debug stub (`debug/debugStub.c`) work over `wasm-wasi-core`'s real pipe stdio?
 * The stub blocks in `fd_read` on stdin while stopped, writes frames to stderr, and shares both with the program.
 * Fixtures are `src/web/test/fixtures/debug/{chatty,prog}stub.wasm`, prebuilt with wasi-sdk (see stubChannel.node.test.ts).
 *
 * Needs a workspace folder, --coi and ms-vscode.wasm-wasi-core (see the `test` script in package.json).
 */
suite('vscwClang debug stub over wasm-wasi-core pipes (in browser)', function () {
	this.timeout(120_000);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let wasm: Wasm;
	let extension: vscode.Extension<unknown>;

	suiteSetup(async () => {
		extension = (vscode.extensions.getExtension('undefined_publisher.vscwclang') ?? vscode.extensions.all.find(e => e.id.endsWith('.vscwclang')))!;
		assert.ok(extension, 'vscwclang extension is not loaded');
		wasm = await Wasm.load();
	});

	const fixture = async (name: string) =>
		await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'src', 'web', 'test', 'fixtures', 'debug', name)) as Uint8Array<ArrayBuffer>;

	interface Debuggee { process: WasmProcess; session: StubSession; stdout: () => string; stderr: () => string; exited: Promise<number> }

	async function launch(name: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; dbg: Debuggee }> {
		const bytes = await fixture(name);
		const unsupported = describeUnsupportedImports(WebAssembly.Module.imports(await WebAssembly.compile(bytes)));
		assert.strictEqual(unsupported, undefined, unsupported);
		const process = await wasm.createProcess(name, await WebAssembly.compile(bytes), { stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } } });
		let stdout = '', stderr = '';
		const session = new StubSession(text => process.stdin!.write(encoder.encode(text)), b => { stderr += decoder.decode(b, { stream: true }); });
		process.stdout!.onData(d => { stdout += decoder.decode(d, { stream: true }); });
		process.stderr!.onData(d => session.onStderr(d));
		// Not wasm-wasi-core's own timeout: a hung run() never settles on a trap (vscode-wasm#303), so tests bound every wait themselves.
		const exited = process.run();
		return { bytes, dbg: { process, session, stdout: () => stdout, stderr: () => { session.endStderr(); return stderr; }, exited } };
	}

	async function finish(dbg: Debuggee, expected: number): Promise<void> {
		const timer = setTimeout(() => void dbg.process.terminate(), 20_000);
		try { assert.strictEqual(await dbg.exited, expected); } finally { clearTimeout(timer); }
	}

	test('the program waits for the host at startup, then runs to its exit code once released', async () => {
		const { dbg } = await launch('progstub.wasm');
		try {
			const start = await dbg.session.nextStop(20_000);
			assert.strictEqual(start.reason, 'start');
			await dbg.session.resume('go');
			await finish(dbg, 11);
		} finally { void dbg.process.terminate(); }
	});

	test('a breakpoint stop reports the call stack and serves memory pages; stepping out returns to the caller', async () => {
		const { bytes, dbg } = await launch('progstub.wasm');
		try {
			const scan = scanProgram(bytes);
			const nameOf = (i: number) => scan.module.names.get(i);
			const add = [...scan.guardSites].filter(([, s]) => nameOf(s.funcIndex) === 'add').sort((a, b) => a[1].pc - b[1].pc).map(([g]) => g);
			await dbg.session.nextStop(20_000);
			await dbg.session.setBreakpoints([add[1]]);
			await dbg.session.resume('go');
			const stop = await dbg.session.nextStop(20_000);
			assert.strictEqual(stop.reason, 'breakpoint');
			assert.deepStrictEqual(stop.frames.map(f => nameOf(scan.guardSites.get(f.guard)!.funcIndex)), ['add', 'caller', '__original_main']);

			const page = Math.floor(stop.frames[0].sp / PAGE_SIZE);
			await dbg.session.fetchPages([page]);
			const sp = stop.frames[0].sp;
			assert.strictEqual(dbg.session.memory.read(sp, 4).length, 4, 'the stack page the stub served is readable');

			// Round-trip cost over the real pipes.
			const started = Date.now();
			for (let i = 0; i < 20; i++) { dbg.session.memory.clear(); await dbg.session.fetchPages([page]); }
			console.log(`      (20 page fetches over pipes: ${Date.now() - started} ms)`);

			await dbg.session.setBreakpoints([]);
			await dbg.session.resume('out');
			const out = await dbg.session.nextStop(20_000);
			assert.strictEqual(out.reason, 'step');
			assert.deepStrictEqual(out.frames.map(f => nameOf(scan.guardSites.get(f.guard)!.funcIndex)), ['caller', '__original_main']);
			await dbg.session.resume('go');
			await finish(dbg, 11);
		} finally { void dbg.process.terminate(); }
	});

	test('program input typed while it runs reaches scanf, and its stderr is byte-exact around the stub frames', async () => {
		const { bytes, dbg } = await launch('chattystub.wasm');
		try {
			const scan = scanProgram(bytes);
			const square = [...scan.guardSites].find(([, s]) => scan.module.names.get(s.funcIndex) === 'square')![0];
			await dbg.session.nextStop(20_000);
			await dbg.session.setBreakpoints([square]);
			await dbg.session.resume('go');
			await dbg.process.stdin!.write(encoder.encode('7\n'));
			const stop = await dbg.session.nextStop(20_000);
			assert.strictEqual(stop.reason, 'breakpoint');
			assert.strictEqual(dbg.stderr(), 'got 7\n');
			await dbg.session.resume('go');
			await finish(dbg, 49);
			assert.strictEqual(dbg.stderr(), 'got 7\nin square\n');
			assert.strictEqual(dbg.stdout(), 'enter: result 49\n');
		} finally { void dbg.process.terminate(); }
	});
});
