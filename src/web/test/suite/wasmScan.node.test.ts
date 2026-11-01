import * as assert from 'assert';
import { scanProgram } from '../../debug/wasmScan';

const section = (id: number, payload: number[]) => [id, payload.length, ...payload];
const name = (s: string) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const sleb = (n: number) => { const out: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return out; } out.push(b | 0x80); } };

/** A module importing the hook (type `(i32) -> ()`) with one function whose body is `ops` over `locals` i32 locals. */
function moduleWith(locals: number, ops: number[]): Uint8Array {
	const body = [1, locals, 0x7f, ...ops, 0x0b];
	return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
		...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
		...section(2, [1, ...name('env'), ...name('__sanitizer_cov_trace_pc_guard'), 0, 0]),
		...section(3, [1, 1]),
		...section(10, [1, body.length, ...body])]);
}
const CONST = 0x41, SET = 0x21, GET = 0x20, ADD = 0x6a, CALL = 0x10;

suite('wasmScan: guard addresses', () => {
	test('a constant pushed directly before the hook call', () => {
		const scan = scanProgram(moduleWith(0, [CONST, ...sleb(4096), CALL, 0]));
		assert.deepStrictEqual([...scan.guardSites.keys()], [4096]);
	});

	test('a guard address built from two constants in -O0 locals (SQLite debug build)', () => {
		const scan = scanProgram(moduleWith(3, [
			CONST, ...sleb(70000), SET, 0, CONST, ...sleb(8), SET, 1,
			GET, 0, GET, 1, ADD, SET, 2, GET, 2, CALL, 0,
		]));
		assert.deepStrictEqual([...scan.guardSites.keys()], [70008]);
	});

	test('a local set twice is not a known guard address and fails with the opcodes', () => {
		assert.throws(() => scanProgram(moduleWith(1, [CONST, ...sleb(16), SET, 0, CONST, ...sleb(32), SET, 0, GET, 0, CALL, 0])), /not set exactly once.*\n?.*0x/);
	});
});
