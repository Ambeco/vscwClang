import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DebuggeeEvent } from '../../debug/debuggeeSession';
import { LineEditor, toTerminalNewlines } from '../../debug/lineEditor';
import { parseMessage } from '../../debug/stubChannel';
import { StubDebuggee } from '../../debug/stubDebuggee';
import { scanProgram } from '../../debug/wasmScan';
import { Debuggee } from './stubWorkerHarness';

const ESC = String.fromCharCode(27);
const frame = (text: string) => new TextEncoder().encode(`${ESC}_vscw ${text}${ESC}\\`);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

suite('LineEditor', () => {
	test('echoes typed characters, and Enter completes a line and moves to the next row', () => {
		const e = new LineEditor();
		assert.deepStrictEqual(e.feed('12'), { echo: '12', lines: [] });
		assert.deepStrictEqual(e.feed('3\r'), { echo: '3\r\n', lines: ['123\n'] });
	});

	test('several lines in one chunk (a paste) each complete, and an empty line is still a line', () => {
		assert.deepStrictEqual(new LineEditor().feed('a\rb\n\rc'), { echo: 'a\r\nb\r\n\r\nc', lines: ['a\n', 'b\n', '\n'] });
	});

	test('Backspace removes the last character, erasing it on screen, and does nothing on an empty line', () => {
		const e = new LineEditor();
		assert.deepStrictEqual(e.feed('ab\x7f\x7fx'), { echo: 'ab\b \b\b \bx', lines: [] });
		assert.deepStrictEqual(e.feed('\x7f\x7f\x7f'), { echo: '\b \b', lines: [] });
		assert.deepStrictEqual(e.feed('\r'), { echo: '\r\n', lines: ['\n'] });
	});

	test('arrow keys, F-keys, Ctrl+C and Ctrl+D are ignored, even when an escape sequence is split across chunks', () => {
		const e = new LineEditor();
		assert.deepStrictEqual(e.feed(`a${ESC}[Ab${ESC}OP\x03\x04c`), { echo: 'abc', lines: [] });
		assert.deepStrictEqual(e.feed(`${ESC}`), { echo: '', lines: [] });
		assert.deepStrictEqual(e.feed('[3~'), { echo: '', lines: [] });
		assert.deepStrictEqual(e.feed('\r'), { echo: '\r\n', lines: ['abc\n'] });
	});

	test('a character outside the BMP is one Backspace', () => {
		assert.deepStrictEqual(new LineEditor().feed('a😀\x7f\r'), { echo: 'a😀\b \b\r\n', lines: ['a\n'] });
	});

	test('program output newlines become CR LF without doubling', () => {
		assert.strictEqual(toTerminalNewlines('a\nb\r\nc'), 'a\r\nb\r\nc');
	});
});

suite('stub channel input frames', () => {
	test('input and synced frames parse; input is hex of the raw bytes', () => {
		assert.deepStrictEqual(parseMessage('input 370a'), { kind: 'input', data: new Uint8Array([0x37, 0x0a]) });
		assert.deepStrictEqual(parseMessage('input '), { kind: 'input', data: new Uint8Array(0) });
		assert.deepStrictEqual(parseMessage('synced'), { kind: 'synced' });
	});
});

suite('StubDebuggee program input (scripted stub)', () => {
	// A started session holds a pending wait for the next stop; terminating ends it so mocha can exit.
	const made: StubDebuggee[] = [];
	teardown(async () => { for (const d of made.splice(0)) { await d.terminate(); } });

	/** A debuggee whose "stub" is the test: `sent` logs commands and program input in the order they hit stdin. */
	function setup(reply: (command: string, d: StubDebuggee) => void = () => undefined) {
		const sent: string[] = [];
		const events: DebuggeeEvent[] = [];
		const d: StubDebuggee = new StubDebuggee({
			send: t => { sent.push(`cmd:${t.trim()}`); reply(t.trim(), d); },
			sendInput: b => { sent.push(`in:${JSON.stringify(text(b))}`); },
			exited: new Promise<number>(() => undefined),
			terminate: () => undefined,
			guardSites: new Map(),
		});
		d.listener = e => events.push(e);
		made.push(d);
		const stopped = async () => { for (let i = 0; i < 100 && !events.some(e => e.kind === 'stopped'); i++) { await new Promise(r => setTimeout(r, 5)); } events.length = 0; };
		return { d, sent, events, stopped };
	}

	test('input typed while the program runs goes straight to stdin; input typed at a stop waits and follows the resume command', async () => {
		const { d, sent, stopped } = setup((command, self) => {
			// The stub read `early` while waiting for its first command and hands it back, then answers the sync.
			if (command === 'vscw sync') { self.feedStderr(frame('input 6561726c790a')); self.feedStderr(frame('synced')); }
		});
		await d.start();
		await d.writeInput(bytes('early\n')); // the program is running (held at startup): the pipe takes it
		d.feedStderr(frame('hello 100 200'));
		await stopped();
		await d.writeInput(bytes('one\n'));
		await d.writeInput(bytes('two\n'));
		assert.deepStrictEqual(sent, ['in:"early\\n"'], 'nothing is written to a stopped stub');
		await d.resume('continue');
		assert.deepStrictEqual(sent.slice(1), ['cmd:vscw sync', 'cmd:vscw go', 'in:"early\\none\\ntwo\\n"']);
	});

	test('a resume with no program input in flight sends no sync; later typing goes straight to stdin', async () => {
		const { d, sent, stopped } = setup();
		await d.start();
		d.feedStderr(frame('hello 100 200'));
		await stopped();
		await d.resume('continue');
		await d.writeInput(bytes('typed\n'));
		assert.deepStrictEqual(sent, ['cmd:vscw go', 'in:"typed\\n"']);
	});

	test('input handed back by the stub is re-sent before input typed at the stop, and only after the sync reply', async () => {
		const { d, sent, stopped } = setup((command, self) => {
			if (command === 'vscw sync') { self.feedStderr(frame('input 610a')); self.feedStderr(frame('input 620a')); self.feedStderr(frame('synced')); }
		});
		await d.start();
		d.feedStderr(frame('hello 100 200'));
		await stopped();
		await d.resume('continue'); // runs
		await d.writeInput(bytes('a\n'));
		await d.writeInput(bytes('b\n'));
		d.feedStderr(frame('stop breakpoint 0'));
		await stopped();
		await d.writeInput(bytes('c\n')); // typed after the stop frame, before the handed-back lines arrive
		sent.length = 0;
		await d.resume('continue');
		assert.deepStrictEqual(sent, ['cmd:vscw sync', 'cmd:vscw go', 'in:"a\\nb\\nc\\n"']);
	});

	test('without sendInput, forwarding input fails with a suggestion; after the program ends, input is dropped', async () => {
		const bare = new StubDebuggee({ send: () => undefined, exited: new Promise<number>(() => undefined), terminate: () => undefined, guardSites: new Map() });
		made.push(bare);
		await bare.start();
		await assert.rejects(bare.writeInput(bytes('x\n')), /did you mean to pass sendInput/);
		const sent: string[] = [];
		const gone = new StubDebuggee({ send: () => undefined, sendInput: b => { sent.push(text(b)); }, exited: Promise.resolve(3), terminate: () => undefined, guardSites: new Map() });
		await gone.start();
		await new Promise(r => setTimeout(r, 10));
		await gone.writeInput(bytes('late\n')); // exited: nothing to forward to, nothing thrown
		assert.deepStrictEqual(sent, []);
	});

	test('onOutput receives stdout and stderr text instead of the listener', async () => {
		const out: string[] = [];
		const d = new StubDebuggee({ send: () => undefined, exited: new Promise<number>(() => undefined), terminate: () => undefined, guardSites: new Map(), onOutput: (s, t) => out.push(`${s}:${t}`) });
		const events: DebuggeeEvent[] = [];
		d.listener = e => events.push(e);
		d.feedStdout(bytes('hi\n'));
		d.feedStderr(bytes('oops\n'));
		assert.deepStrictEqual(out, ['stdout:hi\n', 'stderr:oops\n']);
		assert.deepStrictEqual(events, []);
	});
});

const CHATTY = join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'debug', 'chattystub.wasm');
const suiteIfChatty = existsSync(CHATTY) ? suite : suite.skip;

// chatty.c prints "enter: ", reads an int with scanf, and calls square(n) (exit code n*n) after printing to stderr.
suiteIfChatty('StubDebuggee program input (real stub, real program)', function () {
	this.timeout(60000);
	const wasm = new Uint8Array(readFileSync(CHATTY));
	const scan = scanProgram(wasm);
	let dbg: Debuggee;
	let d: StubDebuggee;
	let events: DebuggeeEvent[];

	setup(() => {
		events = [];
		dbg = new Debuggee(wasm);
		d = new StubDebuggee({ send: t => dbg.write(t), sendInput: b => dbg.write(text(b)), exited: dbg.exited, terminate: () => void dbg.terminate(), guardSites: scan.guardSites });
		d.listener = e => events.push(e);
		dbg.onStdout = b => d.feedStdout(b);
		dbg.onStderr = b => d.feedStderr(b);
	});
	teardown(async () => { await dbg.terminate(); });

	const next = async (kind: DebuggeeEvent['kind']) => {
		for (let i = 0; i < 2000; i++) {
			const at = events.findIndex(e => e.kind === kind);
			if (at >= 0) { return events.splice(at, 1)[0]; }
			await new Promise(r => setTimeout(r, 5));
		}
		throw new Error(`no ${kind} event; got ${JSON.stringify(events)}`);
	};

	test('a line typed before the program is released is not taken for a command: the stub hands it back and scanf gets it', async () => {
		await d.start();
		await d.writeInput(bytes('7\n')); // arrives while the stub waits for its first command
		await next('stopped');
		await d.resume('continue');
		const exited = await next('exited') as { exitCode: number };
		assert.strictEqual(exited.exitCode, 49);
		assert.strictEqual(dbg.stdout, 'enter: result 49\n');
	});

	test('a line typed at a breakpoint stop waits for the resume and then reaches scanf', async () => {
		await d.start();
		await next('stopped');
		const entry = [...scan.guardSites].find(([, s]) => scan.module.names.get(s.funcIndex) === '__original_main')![0];
		await d.setBreakpoints([entry]);
		await d.resume('continue');
		await next('stopped'); // main's first block, before the prompt and the read
		await d.writeInput(bytes('5\n'));
		assert.strictEqual(dbg.stdout, '', 'the program has not printed its prompt yet');
		await d.setBreakpoints([]);
		await d.resume('continue');
		assert.strictEqual(((await next('exited')) as { exitCode: number }).exitCode, 25);
		assert.strictEqual(dbg.stdout, 'enter: result 25\n');
	});

	test('input typed while the program waits in scanf reaches it, and a breakpoint after the read still stops', async () => {
		await d.start();
		await next('stopped');
		const square = [...scan.guardSites].find(([, s]) => scan.module.names.get(s.funcIndex) === 'square')![0];
		await d.setBreakpoints([square]);
		await d.resume('continue');
		await d.writeInput(bytes('6\n'));
		const stop = await next('stopped') as { reason: string };
		assert.strictEqual(stop.reason, 'breakpoint');
		await d.resume('continue');
		assert.strictEqual(((await next('exited')) as { exitCode: number }).exitCode, 36);
	});
});
