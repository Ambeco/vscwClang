/**
 * Static and runtime helpers for a "debug" build's coverage hooks (vscode-free, so node tests can use it).
 *
 * A program built with `-fsanitize-coverage=trace-pc-guard` calls a hook with only a guard address, never a PC.
 * `scanGuardSites` recovers the guard -> {function, DWARF pc} map from the wasm bytes. `ShadowStack` rebuilds the
 * call stack from consecutive hook firings by comparing `__stack_pointer`. `captureWasmFrames` reads the true wasm
 * call stack (with call-site PCs) from the engine's stack trace; it is slow, so use it when delivering a stop.
 *
 * A DWARF code address is an offset from the start of the CODE section payload. Hooks fire per basic block, not per
 * statement. A leaf function that never touches `__stack_pointer` is invisible to the ShadowStack but still appears
 * in `captureWasmFrames`. The stack-trace regex covers V8 (`wasm-function[6]:0x145`) and SpiderMonkey; JavaScriptCore
 * is unverified. Ported from the llvm-project fork's `wasi-tests/sancov_host.mjs`.
 */

const CALL_SITE = /wasm-function\[(\d+)\]:0x([0-9a-f]+)/g;

export const HOOK_IMPORT = { module: 'env', name: '__sanitizer_cov_trace_pc_guard' };

class Reader {
	constructor(readonly b: Uint8Array, public pos = 0) {}
	u8(): number {
		if (this.pos >= this.b.length) { throw new Error(`wasm decode ran past the end of the module at offset ${this.pos}`); }
		return this.b[this.pos++];
	}
	u32(): number {
		let result = 0, shift = 0, byte: number;
		do { byte = this.u8(); result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
		return result;
	}
	s32(): number {
		let result = 0, shift = 0, byte: number;
		do { byte = this.u8(); result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
		if (shift < 32 && (byte & 0x40)) { result |= -1 << shift; }
		return result | 0;
	}
	skipLeb(): void { while (this.u8() & 0x80) { /* skip */ } }
	skip(n: number): void { this.pos += n; }
	name(): string {
		const n = this.u32();
		const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
		this.pos += n;
		return s;
	}
}

function skipMemarg(r: Reader): void {
	const align = r.u32();
	if (align >= 64) { r.skipLeb(); } // multi-memory: explicit memory index follows
	r.skipLeb();
}

/** Skips one instruction's immediates; returns the i32.const value for 0x41, else undefined. */
function readImmediates(r: Reader, op: number): number | undefined {
	if (op === 0x41) { return r.s32(); }
	if (op >= 0x28 && op <= 0x3e) { skipMemarg(r); return; }
	if (op >= 0x45 && op <= 0xc4) { return; }
	switch (op) {
		case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b: case 0x19: case 0x0a: case 0xd1:
			return;
		case 0x02: case 0x03: case 0x04: r.skipLeb(); return;
		case 0x0c: case 0x0d: case 0x10: case 0x12: case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
		case 0x25: case 0x26: case 0xd2: case 0x07: case 0x08: case 0x09: case 0x18:
			r.skipLeb(); return;
		case 0x0e: { const n = r.u32(); for (let i = 0; i <= n; i++) { r.skipLeb(); } return; }
		case 0x11: case 0x13: r.skipLeb(); r.skipLeb(); return;
		case 0x1c: { const n = r.u32(); r.skip(n); return; }
		case 0x3f: case 0x40: case 0xd0: r.skipLeb(); return;
		case 0x42: r.skipLeb(); return;
		case 0x43: r.skip(4); return;
		case 0x44: r.skip(8); return;
		case 0xfc: {
			const sub = r.u32();
			if (sub <= 7) { return; }
			if (sub === 9 || sub === 13 || sub === 11 || (sub >= 15 && sub <= 17)) { r.skipLeb(); return; }
			if (sub === 8 || sub === 10 || sub === 12 || sub === 14) { r.skipLeb(); r.skipLeb(); return; }
			break;
		}
		case 0xfe: {
			const sub = r.u32();
			if (sub === 0x03) { r.skip(1); return; }
			skipMemarg(r);
			return;
		}
		case 0xfd: {
			const sub = r.u32();
			if (sub <= 0x0b || sub === 0x5c || sub === 0x5d) { skipMemarg(r); return; }
			if (sub === 0x0c || sub === 0x0d) { r.skip(16); return; }
			if (sub >= 0x15 && sub <= 0x22) { r.skip(1); return; }
			if (sub >= 0x54 && sub <= 0x5b) { skipMemarg(r); r.skip(1); return; }
			return;
		}
	}
	throw new Error(`unsupported wasm opcode 0x${op.toString(16)} at offset ${r.pos - 1} while scanning for hook calls; did you mean to extend readImmediates() in wasmScan.ts for this (exception-handling?) instruction?`);
}

export interface WasmModuleInfo {
	funcImports: { module: string; name: string }[];
	/** Offset of the CODE section payload in the file: DWARF address = file offset - codeStart. */
	codeStart: number;
	bodies: { start: number; end: number }[];
	/** Exported function name -> function index. */
	funcExports: Map<string, number>;
	/** Function index -> name, from the `name` section (absent in stripped toolchain binaries, present in user debug builds). */
	names: Map<number, string>;
	/** Custom sections other than `name` (e.g. `.debug_line`): payload start and end as file offsets. */
	customSections: Map<string, { start: number; end: number }>;
}

export function parseModule(bytes: Uint8Array): WasmModuleInfo {
	const r = new Reader(bytes, 8);
	const mod: WasmModuleInfo = { funcImports: [], codeStart: -1, bodies: [], funcExports: new Map(), names: new Map(), customSections: new Map() };
	while (r.pos < bytes.length) {
		const id = r.u8();
		const size = r.u32();
		const end = r.pos + size;
		if (id === 2) {
			const n = r.u32();
			for (let i = 0; i < n; i++) {
				const module = r.name(), name = r.name(), kind = r.u8();
				if (kind === 0) { r.skipLeb(); mod.funcImports.push({ module, name }); }
				else if (kind === 1) { r.skip(1); const f = r.u8(); r.skipLeb(); if (f & 1) { r.skipLeb(); } }
				else if (kind === 2) { const f = r.u8(); r.skipLeb(); if (f & 1) { r.skipLeb(); } }
				else if (kind === 3) { r.skip(2); }
				else { r.skipLeb(); r.skipLeb(); }
			}
		} else if (id === 7) {
			const n = r.u32();
			for (let i = 0; i < n; i++) {
				const name = r.name(), kind = r.u8(), index = r.u32();
				if (kind === 0) { mod.funcExports.set(name, index); }
			}
		} else if (id === 10) {
			mod.codeStart = r.pos;
			const n = r.u32();
			for (let i = 0; i < n; i++) {
				const bodySize = r.u32();
				mod.bodies.push({ start: r.pos, end: r.pos + bodySize });
				r.pos += bodySize;
			}
		} else if (id === 0) {
			const sectionName = r.name();
			if (sectionName !== 'name') { mod.customSections.set(sectionName, { start: r.pos, end }); }
			if (sectionName === 'name') {
				while (r.pos < end) {
					const sub = r.u8(), subSize = r.u32(), subEnd = r.pos + subSize;
					if (sub === 1) {
						const n = r.u32();
						for (let i = 0; i < n; i++) { const idx = r.u32(); mod.names.set(idx, r.name()); }
					}
					r.pos = subEnd;
				}
			}
		}
		r.pos = end;
	}
	if (mod.codeStart < 0) { throw new Error('wasm module has no code section; did you mean to pass a linked program (.wasm), not an object file?'); }
	return mod;
}

function last<T>(items: T[], fromEnd: number): T | undefined { return items[items.length - fromEnd]; }

export interface GuardSite { pc: number; funcIndex: number }

export interface ScanResult {
	guardSites: Map<number, GuardSite>;
	/** Function index -> index of the wasm local holding its frame base (what DW_AT_frame_base names); absent for frameless functions. */
	frameBaseLocals: Map<number, number>;
	module: WasmModuleInfo;
}

/**
 * Finds every `call <hook>` with the guard address pushed before it, and each function's frame-base local.
 *
 * The hook is either an import (a host-provided hook) or an exported function of the same name (the in-process
 * debug stub, linked with `-Wl,--export=__sanitizer_cov_trace_pc_guard`).
 */
export function scanProgram(bytes: Uint8Array, hookImport = HOOK_IMPORT): ScanResult {
	const mod = parseModule(bytes);
	const importIndex = mod.funcImports.findIndex(i => i.module === hookImport.module && i.name === hookImport.name);
	const hookIndex = importIndex >= 0 ? importIndex : (mod.funcExports.get(hookImport.name) ?? -1);
	if (hookIndex < 0) {
		throw new Error(`module neither imports ${hookImport.module}.${hookImport.name} nor exports ${hookImport.name}; did you mean to build in debug mode (-fsanitize-coverage=trace-pc-guard, plus -Wl,--export=${hookImport.name} when linking the debug stub)?`);
	}
	const guardSites = new Map<number, GuardSite>();
	const frameBaseLocals = new Map<number, number>();
	mod.bodies.forEach((body, bodyIdx) => {
		const funcIndex = mod.funcImports.length + bodyIdx;
		const r = new Reader(bytes, body.start);
		const nLocalGroups = r.u32();
		for (let i = 0; i < nLocalGroups; i++) { r.skipLeb(); r.skip(1); }
		const recent: { op: number; imm: number | undefined }[] = [];
		while (r.pos < body.end) {
			const at = r.pos;
			const op = r.u8();
			let imm: number | undefined;
			let local: number | undefined;
			if (op === 0x10) { imm = r.u32(); }
			else if (op === 0x21 || op === 0x22) { local = r.u32(); }
			else { imm = readImmediates(r, op); }
			if (op === 0x10 && imm === hookIndex) {
				const [p1, p2, p3] = [last(recent, 1), last(recent, 2), last(recent, 3)];
				let guard: number;
				if (p1?.op === 0x41) { guard = p1.imm!; }
				else if (p1?.op === 0x6a && p2?.op === 0x41 && p3?.op === 0x41) { guard = p3.imm! + p2.imm!; }
				else { throw new Error(`hook call at wasm offset 0x${at.toString(16)} has an unrecognized guard-address sequence (previous opcodes: ${recent.map(x => '0x' + x.op.toString(16)).join(', ')})`); }
				guardSites.set(guard >>> 0, { pc: at - mod.codeStart, funcIndex });
			}
			// Prologue: global.get __stack_pointer; i32.const N; i32.sub; local.set/tee <frame base>
			if (local !== undefined && !frameBaseLocals.has(funcIndex)
				&& last(recent, 1)?.op === 0x6b && last(recent, 2)?.op === 0x41 && last(recent, 3)?.op === 0x23) {
				frameBaseLocals.set(funcIndex, local);
			}
			recent.push({ op, imm });
			if (recent.length > 3) { recent.shift(); }
		}
	});
	return { guardSites, frameBaseLocals, module: mod };
}

export interface ShadowEntry { funcIndex: number; pc: number; sp: number }

/** Call stack rebuilt from hook firings, innermost last. */
export class ShadowStack {
	readonly entries: ShadowEntry[] = [];

	constructor(private readonly guardSites: Map<number, GuardSite>) {}

	/** Pops frames that have returned, given the live `__stack_pointer`. */
	sync(sp: number): void {
		while (this.entries.length && this.entries[this.entries.length - 1].sp < sp) { this.entries.pop(); }
	}

	onHook(sp: number, guard: number): ShadowEntry {
		const site = this.guardSites.get(guard);
		if (!site) { throw new Error(`hook fired for unknown guard address ${guard}; known: ${[...this.guardSites.keys()].join(', ')}`); }
		this.sync(sp);
		const top = this.entries[this.entries.length - 1];
		if (top && top.sp === sp) { top.pc = site.pc; }
		else { this.entries.push({ funcIndex: site.funcIndex, pc: site.pc, sp }); }
		return this.entries[this.entries.length - 1];
	}

	/** Innermost first. */
	frames(): ShadowEntry[] { return [...this.entries].reverse(); }
}

export interface TrueFrame { funcIndex: number; pc: number }

/** The engine's real wasm call stack, innermost first; the hook function must call this directly for `onlyInnermost`. */
export function captureWasmFrames(codeStart: number, onlyInnermost = false): TrueFrame[] {
	const errorClass = Error as { stackTraceLimit: number };
	const saved = errorClass.stackTraceLimit;
	errorClass.stackTraceLimit = onlyInnermost ? 3 : Infinity;
	const stack = new Error().stack ?? '';
	errorClass.stackTraceLimit = saved;
	return [...stack.matchAll(CALL_SITE)].map(m => ({ funcIndex: Number(m[1]), pc: parseInt(m[2], 16) - codeStart }));
}

/** Pairs true frames with shadow entries by function index from the innermost frame outwards; frames with none get sp = null. */
export function mergeFrames(trueFrames: TrueFrame[], shadow: ShadowStack): (TrueFrame & { sp: number | null })[] {
	const remaining = shadow.frames();
	return trueFrames.map(f => {
		const next = remaining[0];
		if (next && next.funcIndex === f.funcIndex) { remaining.shift(); return { ...f, sp: next.sp }; }
		return { ...f, sp: null };
	});
}
