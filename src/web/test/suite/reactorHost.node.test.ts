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

// locals.wasm is src/web/test/fixtures/debug/locals.c built by scripts/build-debug-fixtures.mjs (no debug stub: the test supplies the hook).
const LOCALS = join(ROOT, 'src', 'web', 'test', 'fixtures', 'debug', 'locals.wasm');

suiteIfReactor('ReactorHost.variables (real lldb-wasm-reactor.wasm, locals.c)', function () {
	this.timeout(120000);
	const bytes = new Uint8Array(readFileSync(LOCALS));
	const scan = scanProgram(bytes);
	let host: ReactorHost;

	suiteSetup(async () => {
		host = await ReactorHost.create(await WebAssembly.compile(readFileSync(REACTOR)));
		host.createTarget(bytes);
	});

	/** Runs the program and calls `inspect` at the `which`th hook (0-based, negative from the end) of the named function. */
	function stopIn<T>(fn: string, which: number, inspect: () => T): T {
		const funcIndex = [...scan.module.names].find(([, n]) => n === fn)?.[0];
		assert.ok(funcIndex !== undefined, `name section has ${fn}`);
		const guards = [...scan.guardSites].filter(([, s]) => s.funcIndex === funcIndex).map(([g]) => g).sort((a, b) => a - b);
		const target = guards[which < 0 ? guards.length + which : which];
		const shadow = new ShadowStack(scan.guardSites);
		let instance!: WebAssembly.Instance;
		let result: { value: T } | undefined;
		const hook = (guard: number) => {
			const sp = (instance.exports.__stack_pointer as WebAssembly.Global).value as number;
			shadow.onHook(sp, guard);
			if (guard !== target || result) { return; }
			const frames = mergeFrames(captureWasmFrames(scan.module.codeStart), shadow)
				.filter(f => f.sp !== null && scan.frameBaseLocals.has(f.funcIndex))
				.map(f => ({ pc: f.pc, sp: f.sp!, frameBaseLocal: scan.frameBaseLocals.get(f.funcIndex)! }));
			host.setMemory({ read: (addr, size) => new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).slice(addr, addr + size) });
			host.setStop(frames);
			result = { value: inspect() };
		};
		instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
			env: { __sanitizer_cov_trace_pc_guard: hook, __sanitizer_cov_trace_pc_guard_init() { /* unused */ } },
			wasi_snapshot_preview1: { proc_exit() { throw new ProgramExit(); } },
		});
		try { (instance.exports._start as () => void)(); } catch (e) { if (!(e instanceof ProgramExit)) { throw e; } }
		assert.ok(result, `hook ${which} of ${fn} fired`);
		return result.value;
	}

	test('lists parameters then locals with types and values, and marks the ones with children', () => {
		const vars = stopIn('mixed', -1, () => host.variables(0));
		const byName = new Map(vars.map(v => [v.name, v]));
		assert.deepStrictEqual(vars.slice(0, 6).map(v => v.name), ['d', 's', 'pv', 'bp', 'll', 'uc'], vars.map(v => v.name).join(','));
		assert.match(byName.get('d')!.type, /double/);
		assert.strictEqual(byName.get('d')!.value, '1.5');
		assert.strictEqual(byName.get('ll')!.value, '123456789012');
		assert.strictEqual(byName.get('f')!.value, '2.5');
		assert.match(byName.get('s')!.value, /"hey"/);
		for (const aggregate of ['arr', 'local', 'bp', 'pv']) { assert.ok(byName.get(aggregate)!.hasChildren, `${aggregate} has children`); }
		assert.ok(!byName.get('total')!.hasChildren);
		assert.ok(!vars.some(v => v.name.startsWith('__vla_expr')), 'compiler-made variables are hidden');
	});

	test('expands arrays, structs and pointers by path, through nested levels', () => {
		const result = stopIn('mixed', -1, () => {
			const vars = host.variables(0);
			const arr = host.variables(0, vars.find(v => v.name === 'arr')!.path);
			const local = host.variables(0, vars.find(v => v.name === 'local')!.path);
			const p = host.variables(0, local.find(v => v.name === 'p')!.path);
			const bp = host.variables(0, vars.find(v => v.name === 'bp')!.path);
			return { arr, local, p, bp };
		});
		assert.deepStrictEqual(result.arr.map(v => v.value), ['1', '2', '3', '4']);
		assert.deepStrictEqual(result.local.map(v => v.name), ['d', 'tag', 'p']);
		assert.deepStrictEqual(result.p.map(v => `${v.name}=${v.value}`), ['x=3', 'y=4']);
		assert.deepStrictEqual(result.bp.map(v => v.name), ['d', 'tag', 'p'], 'a pointer to a struct lists the members of what it points to');
	});

	test('an outer frame lists its own variables', () => {
		const frame1 = stopIn('leaf', 0, () => host.variables(1));
		assert.deepStrictEqual(frame1.map(v => v.name), ['big', 'pv', 'r']);
	});

	test('a block-scoped variable is listed only while in scope', () => {
		const inLoop = stopIn('mixed', 2, () => host.variables(0).map(v => v.name));
		const after = stopIn('mixed', -1, () => host.variables(0).map(v => v.name));
		assert.ok(inLoop.includes('i') && !after.includes('i'), `in loop: ${inLoop}; after: ${after}`);
	});

	test('a sibling call at the same stack pointer still shows its own frame', () => {
		const names = stopIn('shadow', 0, () => host.variables(0).map(v => v.name));
		assert.ok(names.includes('n') && names.includes('v'), names.join(','));
	});

	test('a bad variable path is an error', () => {
		assert.throws(() => stopIn('mixed', -1, () => host.variables(0, '99')), /no value|none at index/);
		assert.throws(() => stopIn('mixed', -1, () => host.variables(0, 'x/y')), /not a variable path/);
	});

	test('a function with no branches shows its parameter at its last line guard', () => {
		assert.deepStrictEqual(stopIn('leaf', -1, () => host.variables(0).map(v => `${v.name}=${v.value}`)), ['q=1']);
	});

	test('a VLA function lists n and sum inside its loop, after the stack pointer moved', () => {
		for (const which of [1, 2, 3]) {
			const vars = stopIn('vla', which, () => host.variables(0));
			const byName = new Map(vars.map(v => [v.name, v.value]));
			assert.strictEqual(byName.get('n'), '4', `hook ${which}`);
			assert.ok(byName.has('i'), `hook ${which} is in the loop`);
		}
		const frames = stopIn('vla', 2, () => host.backtrace());
		assert.strictEqual(frames.length, 2, `no phantom frames: ${frames.join(' | ')}`);
	});

	// The compiler spills the by-value pointer / VLA address (-sanitizer-coverage-spill-debug-vars) so memory reads suffice.
	test('a struct passed by value is listed with its members (pv in mixed)', () => {
		const members = stopIn('mixed', -1, () => {
			const pv = host.variables(0).find(v => v.name === 'pv');
			assert.ok(pv?.hasChildren);
			return host.variables(0, pv.path).map(v => `${v.name}=${v.value}`);
		});
		assert.deepStrictEqual(members, ['x=3', 'y=4']);
	});

	test('a VLA is listed with its elements (buf in vla)', () => {
		const elements = stopIn('vla', -1, () => {
			const buf = host.variables(0).find(v => v.name === 'buf');
			assert.ok(buf?.hasChildren);
			assert.match(buf.type, /int/);
			return host.variables(0, buf.path).map(v => v.value);
		});
		assert.deepStrictEqual(elements, ['0', '3', '6', '9']);
	});

	test('a by-value struct and a VLA are readable at the entry guard, before any user code ran', () => {
		const pv = stopIn('mixed', 0, () => host.variables(0).find(v => v.name === 'pv'));
		assert.ok(pv?.hasChildren, 'pv readable at entry');
	});
});
