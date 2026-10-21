/**
 * Minimal DWARF `.debug_line` reader (versions 2-5, 32-bit DWARF; vscode-free, so node tests can use it).
 *
 * The lldb reactor maps a pc to a line but cannot go the other way, and a breakpoint on a source line needs the
 * addresses that line owns. Addresses are wasm code offsets (relative to the CODE section payload), the same
 * space as `scanProgram`'s guard pcs. Sequences that start at address 0 belong to code the linker discarded and
 * are dropped.
 */

export interface LineRow {
	addr: number;
	file: string;
	line: number;
	isStmt: boolean;
	endSequence: boolean;
}

interface Range { start: number; end: number }

class Cursor {
	constructor(readonly b: Uint8Array, public pos: number) {}
	u8(): number { return this.b[this.pos++]; }
	i8(): number { return (this.u8() << 24) >> 24; }
	u16(): number { const v = this.b[this.pos] | (this.b[this.pos + 1] << 8); this.pos += 2; return v; }
	u32(): number { const v = (this.b[this.pos] | (this.b[this.pos + 1] << 8) | (this.b[this.pos + 2] << 16) | (this.b[this.pos + 3] << 24)) >>> 0; this.pos += 4; return v; }
	uleb(): number {
		let result = 0, shift = 0, byte: number;
		do { byte = this.u8(); result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
		return result;
	}
	sleb(): number {
		let result = 0, shift = 0, byte: number;
		do { byte = this.u8(); result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
		return byte & 0x40 ? result - 2 ** shift : result;
	}
	cstr(): string {
		let end = this.pos;
		while (this.b[end] !== 0) { end++; }
		const s = new TextDecoder().decode(this.b.subarray(this.pos, end));
		this.pos = end + 1;
		return s;
	}
}

const FORM = { string: 0x08, strp: 0x0e, lineStrp: 0x1f, udata: 0x0f, data1: 0x0b, data2: 0x05, data4: 0x06, data8: 0x07, data16: 0x1e, block: 0x09 };
const LNCT_PATH = 1, LNCT_DIRECTORY_INDEX = 2;

function stringAt(bytes: Uint8Array, section: Range | undefined, offset: number, which: string): string {
	if (!section) { throw new Error(`.debug_line refers to a string in ${which}, but the program has no such section; did you mean to build with -g (DWARF 5)?`); }
	return new Cursor(bytes, section.start + offset).cstr();
}

function isAbsolute(path: string): boolean { return /^([/\\]|[A-Za-z]:)/.test(path); }
function joinPath(dir: string, name: string): string { return isAbsolute(name) || !dir ? name : `${dir.replace(/[/\\]+$/, '')}/${name}`; }

/** Parses every line program in `.debug_line`; `sections` is `parseModule(bytes).customSections`. */
export function parseLineTable(bytes: Uint8Array, sections: Map<string, Range>): LineRow[] {
	const section = sections.get('.debug_line');
	if (!section) { throw new Error('the program has no .debug_line section; did you mean to build in debug mode (-g)?'); }
	const lineStr = sections.get('.debug_line_str'), str = sections.get('.debug_str');
	const rows: LineRow[] = [];
	const c = new Cursor(bytes, section.start);
	while (c.pos < section.end) {
		const unitLength = c.u32();
		if (unitLength === 0xffffffff) { throw new Error('64-bit DWARF line tables are not supported; did you mean to build without -gdwarf64?'); }
		const unitEnd = c.pos + unitLength;
		const version = c.u16();
		if (version < 2 || version > 5) { throw new Error(`unsupported .debug_line version ${version}; expected 2 to 5`); }
		if (version >= 5) { c.u8(); c.u8(); } // address size, segment selector size
		const headerLength = c.u32();
		const programStart = c.pos + headerLength;
		const minInst = c.u8();
		if (version >= 4) { c.u8(); } // max ops per instruction (VLIW only)
		const defaultIsStmt = c.u8() !== 0;
		const lineBase = c.i8(), lineRange = c.u8(), opcodeBase = c.u8();
		const opcodeLengths: number[] = [];
		for (let i = 1; i < opcodeBase; i++) { opcodeLengths.push(c.u8()); }

		const readForm = (form: number): string | number => {
			switch (form) {
				case FORM.string: return c.cstr();
				case FORM.lineStrp: return stringAt(bytes, lineStr, c.u32(), '.debug_line_str');
				case FORM.strp: return stringAt(bytes, str, c.u32(), '.debug_str');
				case FORM.udata: return c.uleb();
				case FORM.data1: return c.u8();
				case FORM.data2: return c.u16();
				case FORM.data4: return c.u32();
				case FORM.data8: c.pos += 8; return 0;
				case FORM.data16: c.pos += 16; return 0;
				case FORM.block: c.pos += c.uleb(); return 0;
			}
			throw new Error(`.debug_line uses form 0x${form.toString(16)}, which is not supported; did you mean to extend readForm() in dwarfLines.ts?`);
		};
		const readEntries = (): { path: string; dir: number }[] => {
			const formats: [number, number][] = [];
			for (let n = c.u8(); n > 0; n--) { formats.push([c.uleb(), c.uleb()]); }
			const entries: { path: string; dir: number }[] = [];
			for (let n = c.uleb(); n > 0; n--) {
				const entry = { path: '', dir: 0 };
				for (const [type, form] of formats) {
					const v = readForm(form);
					if (type === LNCT_PATH) { entry.path = String(v); } else if (type === LNCT_DIRECTORY_INDEX) { entry.dir = Number(v); }
				}
				entries.push(entry);
			}
			return entries;
		};

		const dirs: string[] = [];
		const files: string[] = []; // indexed by the line program's file register
		if (version >= 5) {
			for (const d of readEntries()) { dirs.push(d.path); }
			for (const f of readEntries()) { files.push(joinPath(dirs[f.dir] ?? '', f.path)); }
		} else {
			dirs.push('');
			for (let d = c.cstr(); d !== ''; d = c.cstr()) { dirs.push(d); }
			files.push(''); // version <= 4 numbers files from 1
			for (let name = c.cstr(); name !== ''; name = c.cstr()) { const dir = c.uleb(); c.uleb(); c.uleb(); files.push(joinPath(dirs[dir] ?? '', name)); }
		}

		c.pos = programStart;
		let addr = 0, file = 1, line = 1, isStmt = defaultIsStmt;
		const emit = (endSequence: boolean) => {
			rows.push({ addr, file: files[file] ?? '', line, isStmt, endSequence });
		};
		const resetSequence = () => { addr = 0; file = 1; line = 1; isStmt = defaultIsStmt; };
		let sequenceFirstRow = rows.length;
		while (c.pos < unitEnd) {
			const op = c.u8();
			if (op >= opcodeBase) {
				const adj = op - opcodeBase;
				addr += Math.floor(adj / lineRange) * minInst;
				line += lineBase + (adj % lineRange);
				emit(false);
			} else if (op === 0) {
				const len = c.uleb(), next = c.pos + len, sub = c.u8();
				if (sub === 1) {
					emit(true);
					if (rows[sequenceFirstRow].addr === 0) { rows.length = sequenceFirstRow; } // discarded code
					resetSequence();
					sequenceFirstRow = rows.length;
				} else if (sub === 2) {
					let v = 0;
					for (let i = 0; i < len - 1; i++) { v += c.u8() * 2 ** (8 * i); }
					addr = v;
				}
				c.pos = next;
			} else {
				switch (op) {
					case 1: emit(false); break;
					case 2: addr += c.uleb() * minInst; break;
					case 3: line += c.sleb(); break;
					case 4: file = c.uleb(); break;
					case 5: c.uleb(); break;
					case 6: isStmt = !isStmt; break;
					case 8: addr += Math.floor((255 - opcodeBase) / lineRange) * minInst; break;
					case 9: addr += c.u16(); break;
					case 12: c.uleb(); break;
					case 7: case 10: case 11: break;
					default: for (let i = 0; i < opcodeLengths[op - 1]; i++) { c.uleb(); }
				}
			}
		}
		c.pos = unitEnd;
	}
	return rows;
}
