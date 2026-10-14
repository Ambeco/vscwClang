import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ReactorHost } from '../../debug/reactorHost';
import { captureWasmFrames, mergeFrames, scanProgram, ShadowStack } from '../../debug/wasmScan';

// prog.wasm is test/fixtures/debug/prog.c built with:
//   clang -O0 -g -fsanitize-coverage=trace-pc-guard -Wl,--export=__stack_pointer -Wl,--allow-undefined
// (wasi-sdk 34). The reactor comes from the local toolchain copy (llvm-artifacts is gitignored), so tests skip without it.
const ROOT = process.cwd();
const REACTOR = join(ROOT, 'llvm-artifacts', 'bin', 'lldb-wasm-reactor.wasm');
const PROG = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'prog.wasm');

class ProgramExit extends Error {}

suite('wasmScan (debug program analysis)', () => {
	const bytes = new Uint8Array(readFileSync(PROG));

	test('finds a guard per basic block, each inside a function, and a frame-base local for functions with locals', () => {
		const scan = scanProgram(bytes);
		assert.ok(scan.guardSites.size >= 6, `guards: ${scan.guardSites.size}`);
		assert.ok(scan.frameBaseLocals.size >= 3, `frame-base locals: ${[...scan.frameBaseLocals]}`);
		for (const site of scan.guardSites.values()) {
			assert.ok(site.pc > 0 && scan.module.bodies[site.funcIndex - scan.module.funcImports.length], `guard in a real function body: ${JSON.stringify(site)}`);
		}
	});

	test('rejects a program built without the coverage hook, with a suggestion', () => {
		const plain = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
		assert.throws(() => scanProgram(plain), /code section/);
	});
});

const suiteIfReactor = existsSync(REACTOR) ? suite : suite.skip;

suiteIfReactor('ReactorHost (real lldb-wasm-reactor.wasm, real debug build)', function () {
	this.timeout(120000);
	const bytes = new Uint8Array(readFileSync(PROG));
	let host: ReactorHost;
	let instance: WebAssembly.Instance;
	let mem: () => Uint8Array;

	suiteSetup(async () => {
		host = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		host.createTarget(bytes);
	});

	test('resolvePc maps every guard into a source line of prog.c', () => {
		const scan = scanProgram(bytes);
		for (const [guard, site] of scan.guardSites) {
			const resolved = host.resolvePc(site.pc);
			assert.match(resolved, /prog\.c:\d+/, `guard ${guard} @0x${site.pc.toString(16)} -> ${resolved}`);
		}
	});

	test('a stop inside add() gives a 3-frame backtrace with real values', () => {
		const scan = scanProgram(bytes);
		const shadow = new ShadowStack(scan.guardSites);
		const addIndex = [...scan.module.names].find(([, n]) => n === 'add')?.[0];
		assert.ok(addIndex !== undefined, 'name section has add');
		let stops = 0;
		let seen: { bt: string[]; values: string[] } | undefined;
		const hook = (guard: number) => {
			const sp = (instance.exports.__stack_pointer as WebAssembly.Global).value as number;
			const entry = shadow.onHook(sp, guard);
			const inAdd = entry.funcIndex === addIndex;
			if (!inAdd || stops++ !== 1) { return; } // second block of add(): after c = a + b
			const frames = mergeFrames(captureWasmFrames(scan.module.codeStart), shadow)
				.filter(f => f.sp !== null)
				.map(f => ({ pc: f.pc, sp: f.sp!, frameBaseLocal: scan.frameBaseLocals.get(f.funcIndex)! }));
			host.setMemory({ read: (addr, size) => mem().slice(addr, addr + size) });
			host.setStop(frames);
			seen = { bt: host.backtrace(), values: [host.formatValue(0, 'a'), host.formatValue(0, 'b'), host.formatValue(0, 'c'), host.formatValue(1, 'p')] };
		};
		instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
			env: { __sanitizer_cov_trace_pc_guard: hook, __sanitizer_cov_trace_pc_guard_init() { /* unused */ } },
			wasi_snapshot_preview1: { proc_exit() { throw new ProgramExit(); } },
		});
		mem = () => new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer);
		try { (instance.exports._start as () => void)(); } catch (e) { if (!(e instanceof ProgramExit)) { throw e; } }
		assert.ok(seen, 'the hook stop in add() fired');
		assert.strictEqual(seen.bt.length, 3, seen.bt.join('\n'));
		assert.match(seen.bt[0], /prog\.c:\d+/);
		// Each frame resolves to its own function (add, caller, main), not all to the first DWARF function.
		const lines = seen.bt.map(f => Number(/prog\.c:(\d+)/.exec(f)?.[1]));
		assert.ok(lines[0] >= 3 && lines[0] <= 8, `frame 0 in add(): ${seen.bt[0]}`);
		assert.ok(lines[1] >= 10 && lines[1] <= 16, `frame 1 in caller(): ${seen.bt[1]}`);
		assert.ok(lines[2] >= 19 && lines[2] <= 20, `frame 2 in main(): ${seen.bt[2]}`);
		assert.match(seen.values[0], /\(int\) a = 1\b/);
		assert.match(seen.values[1], /\(int\) b = 10\b/);
		assert.match(seen.values[2], /\(int\) c = 11\b/);
		assert.match(seen.values[3], /x = 1[^]*y = 2/);
	});

	test('a failed lookup throws lldb\'s own message', () => {
		assert.throws(() => host.formatValue(0, 'no_such_variable'), /vscwClang: lldb could not evaluate "no_such_variable"/);
	});
});
