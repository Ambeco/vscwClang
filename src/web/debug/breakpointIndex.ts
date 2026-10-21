import type { LineRow } from './dwarfLines';
import type { GuardSite, WasmModuleInfo } from './wasmScan';

export interface ResolvedBreakpoint {
	/** The line with code that the request was moved to (the request itself when it has code). */
	line: number;
	/** Guards to arm: one per function that has code on `line` (templates and inline functions have several). */
	guards: number[];
	/** Where the program really stops: the line the enclosing block starts on, when that is not `line`. */
	stopsAtLine: number | undefined;
}

/**
 * Turns a source line into the coverage guards that stop there.
 *
 * The coverage hook runs at the start of every basic block (debug builds use `no-prune`; the default pruning leaves
 * blocks without one), so a line can only stop at the start of the block that contains it: the guard at or just
 * before the line's first address in the same function. A line
 * that starts a block stops exactly; a line in the middle of one stops early, and `stopsAtLine` says where. A line
 * with no code moves to the next line that has some.
 */
export class BreakpointIndex {
	private readonly byFile = new Map<string, Map<number, number[]>>();
	private readonly sortedLines = new Map<string, number[]>();
	private readonly bodyStarts: number[];
	private readonly guardsByFunc = new Map<number, { guard: number; pc: number }[]>();
	private readonly firstFuncIndex: number;
	/** Rows sorted by address (a sequence's end row before the next sequence's first), for `lineAt`. */
	private readonly sortedRows: LineRow[];
	private readonly rowAddrs: number[];

	constructor(rows: LineRow[], guardSites: Map<number, GuardSite>, module: WasmModuleInfo) {
		for (const row of rows) {
			if (row.endSequence || !row.isStmt) { continue; }
			let lines = this.byFile.get(row.file);
			if (!lines) { lines = new Map(); this.byFile.set(row.file, lines); }
			const addrs = lines.get(row.line);
			if (addrs) { addrs.push(row.addr); } else { lines.set(row.line, [row.addr]); }
		}
		for (const [file, lines] of this.byFile) { this.sortedLines.set(file, [...lines.keys()].sort((a, b) => a - b)); }
		this.bodyStarts = module.bodies.map(b => b.start - module.codeStart);
		this.firstFuncIndex = module.funcImports.length;
		for (const [guard, site] of guardSites) {
			const list = this.guardsByFunc.get(site.funcIndex) ?? [];
			list.push({ guard, pc: site.pc });
			this.guardsByFunc.set(site.funcIndex, list);
		}
		for (const list of this.guardsByFunc.values()) { list.sort((a, b) => a.pc - b.pc); }
		this.sortedRows = [...rows].sort((a, b) => a.addr - b.addr || Number(b.endSequence) - Number(a.endSequence));
		this.rowAddrs = this.sortedRows.map(r => r.addr);
	}

	/** The workspace files with line info, as the program's DWARF names them. */
	files(): string[] { return [...this.byFile.keys()]; }

	private funcAt(addr: number): number | undefined {
		let lo = 0, hi = this.bodyStarts.length - 1, found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.bodyStarts[mid] <= addr) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
		}
		return found < 0 ? undefined : this.firstFuncIndex + found;
	}

	/** The source line of the row covering `pc`, or undefined if `pc` is outside any sequence. */
	lineAt(pc: number): { file: string; line: number } | undefined {
		let lo = 0, hi = this.rowAddrs.length - 1, found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.rowAddrs[mid] <= pc) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
		}
		// Several rows can share an address; the last one wins, as in a debugger's line lookup.
		const row = found >= 0 ? this.sortedRows[found] : undefined;
		return row && !row.endSequence ? { file: row.file, line: row.line } : undefined;
	}

	/** True if every row from `from` to `to` is on `line` (or has no line, which the compiler emits for glue code). */
	private onlyLineBetween(from: number, to: number, line: number): boolean {
		let lo = 0, hi = this.rowAddrs.length;
		while (lo < hi) { const mid = (lo + hi) >> 1; if (this.rowAddrs[mid] < from) { lo = mid + 1; } else { hi = mid; } }
		for (let i = lo; i < this.sortedRows.length && this.rowAddrs[i] <= to; i++) {
			const row = this.sortedRows[i];
			if (!row.endSequence && row.line !== line && row.line !== 0) { return false; }
		}
		return true;
	}

	resolve(file: string, line: number): ResolvedBreakpoint | undefined {
		const lines = this.sortedLines.get(file);
		const actual = lines?.find(l => l >= line);
		if (actual === undefined) { return undefined; }
		const firstAddrByFunc = new Map<number, number>();
		for (const addr of this.byFile.get(file)!.get(actual)!) {
			const func = this.funcAt(addr);
			if (func === undefined) { continue; }
			const known = firstAddrByFunc.get(func);
			if (known === undefined || addr < known) { firstAddrByFunc.set(func, addr); }
		}
		const guards: number[] = [];
		let stopsAtLine: number | undefined;
		for (const [func, addr] of firstAddrByFunc) {
			const sites = this.guardsByFunc.get(func);
			if (!sites?.length) { continue; }
			let site = sites[0];
			for (const s of sites) { if (s.pc <= addr) { site = s; } else { break; } }
			// The wasm backend can schedule a block's first instructions before its hook call, so a hook just after
			// the line's first address, with no other line's code in between, belongs to the line's own block.
			const next = sites.find(s => s.pc >= addr);
			if (next && this.onlyLineBetween(addr, next.pc, actual)) { site = next; }
			guards.push(site.guard);
			const startLine = this.lineAt(site.pc)?.line;
			if (startLine !== undefined && startLine !== actual) { stopsAtLine = startLine; }
		}
		return guards.length ? { line: actual, guards, stopsAtLine } : undefined;
	}
}
