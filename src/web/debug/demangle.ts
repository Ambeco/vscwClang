/**
 * Demangles the Itanium C++ names of plain functions for the call stack (`_ZL3addii` -> `add(int, int)`); vscode-free.
 *
 * Covers the common user-code shapes: functions and nested names (namespaces, classes, constructors, destructors,
 * `operator` names without template arguments), internal-linkage `L`, builtin types, `P`/`R`/`O`/`K`/`V`
 * qualifiers, class types and `S_`-free parameter lists. Templates, substitutions (`S_`, `St`), lambdas and function
 * pointers are not decoded: `demangle` then returns the mangled name unchanged, never a wrong one.
 */

const BUILTIN: Record<string, string> = {
	v: 'void', w: 'wchar_t', b: 'bool', c: 'char', a: 'signed char', h: 'unsigned char', s: 'short', t: 'unsigned short',
	i: 'int', j: 'unsigned int', l: 'long', m: 'unsigned long', x: 'long long', y: 'unsigned long long', f: 'float',
	d: 'double', e: 'long double', z: '...', n: '__int128', o: 'unsigned __int128', Di: 'char32_t', Ds: 'char16_t', Du: 'char8_t',
};
const OPERATORS: Record<string, string> = {
	nw: 'new', dl: 'delete', ps: '+', ng: '-', ad: '&', de: '*', co: '~', pl: '+', mi: '-', ml: '*', dv: '/', rm: '%', an: '&', or: '|', eo: '^',
	aS: '=', pL: '+=', mI: '-=', mL: '*=', dV: '/=', rM: '%=', aN: '&=', oR: '|=', eO: '^=', ls: '<<', rs: '>>', lS: '<<=', rS: '>>=',
	eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=', nt: '!', aa: '&&', oo: '||', pp: '++', mm: '--', cm: ',', pm: '->*', pt: '->', cl: '()', ix: '[]',
};

class Unsupported extends Error {}

class Parser {
	at = 0;
	/** cv-qualifiers of the last nested name (`K` on a member function). */
	qualifiers = '';
	constructor(readonly s: string) {}

	peek(n = 1): string { return this.s.slice(this.at, this.at + n); }
	eat(text: string): boolean {
		if (!this.s.startsWith(text, this.at)) { return false; }
		this.at += text.length;
		return true;
	}

	sourceName(): string {
		const m = /^\d+/.exec(this.s.slice(this.at));
		if (!m) { throw new Unsupported(); }
		const n = Number(m[0]);
		const start = this.at + m[0].length;
		if (start + n > this.s.length) { throw new Unsupported(); }
		this.at = start + n;
		const name = this.s.slice(start, start + n);
		return name.startsWith('_GLOBAL__N') ? '(anonymous namespace)' : name;
	}

	/** One component of a (possibly nested) name; `previous` is the class name a constructor or destructor repeats. */
	unqualified(previous: string | undefined): string {
		if (/^\d/.test(this.peek())) { return this.sourceName(); }
		if (this.peek() === 'C' && /^C[123]/.test(this.peek(2)) && previous) { this.at += 2; return previous.replace(/<.*$/, ''); }
		if (this.peek() === 'D' && /^D[012]/.test(this.peek(2)) && previous) { this.at += 2; return '~' + previous.replace(/<.*$/, ''); }
		const op = OPERATORS[this.peek(2)];
		if (op !== undefined) { this.at += 2; return `operator${/^[a-z]/.test(op) ? ' ' : ''}${op}`; }
		throw new Unsupported();
	}

	name(): string {
		this.eat('L');
		if (!this.eat('N')) { return this.unqualified(undefined); }
		let qualifiers = '';
		for (const q of ['r', 'V', 'K']) { if (this.eat(q)) { qualifiers += q === 'K' ? ' const' : q === 'V' ? ' volatile' : ' restrict'; } }
		const parts: string[] = [];
		while (!this.eat('E')) {
			if (this.at >= this.s.length || this.peek() === 'I' || this.peek() === 'S') { throw new Unsupported(); }
			parts.push(this.unqualified(parts[parts.length - 1]));
		}
		this.qualifiers = qualifiers;
		return parts.join('::');
	}

	type(): string {
		for (const [mark, suffix] of [['P', '*'], ['R', '&'], ['O', '&&']] as const) { if (this.eat(mark)) { return this.type() + suffix; } }
		if (this.eat('K')) { return this.type() + ' const'; }
		if (this.eat('V')) { return this.type() + ' volatile'; }
		const two = BUILTIN[this.peek(2)];
		if (two !== undefined && this.peek(1) === 'D') { this.at += 2; return two; }
		const one = BUILTIN[this.peek(1)];
		if (one !== undefined && this.peek(1) !== 'D') { this.at += 1; return one; }
		if (/^\d|^N/.test(this.peek())) {
			if (this.peek() === 'N') { const saved = this.qualifiers; const n = this.name(); this.qualifiers = saved; return n; }
			return this.sourceName();
		}
		throw new Unsupported();
	}
}

/** The demangled name, or `mangled` itself when it is not an Itanium name or uses a feature this does not decode. */
export function demangle(mangled: string): string {
	if (!mangled.startsWith('_Z')) { return mangled; }
	try {
		const p = new Parser(mangled);
		p.at = 2;
		const name = p.name();
		const qualifiers = p.qualifiers;
		if (p.at >= mangled.length) { return name; } // a variable, or a name with no parameter list
		const params: string[] = [];
		while (p.at < mangled.length) { params.push(p.type()); }
		return `${name}(${params.length === 1 && params[0] === 'void' ? '' : params.join(', ')})${qualifiers}`;
	} catch (e) {
		if (e instanceof Unsupported) { return mangled; }
		throw e;
	}
}

/** The name a stack frame shows: `main` for the compiler's `__original_main`, else the demangled function name. */
export function displayFunctionName(wasmName: string): string {
	return wasmName === '__original_main' ? 'main' : demangle(wasmName);
}

/** Whether a breakpoint on `wanted` (`add`, `ns::add`, `Foo::bar` or `add(int, int)`) means the function with this wasm name. */
export function functionNameMatches(wasmName: string, wanted: string): boolean {
	const shown = displayFunctionName(wasmName);
	if (shown === wanted || shown === wasmName && wasmName === wanted) { return true; }
	const bare = shown.replace(/\(.*$/, '');
	return !wanted.includes('(') && (bare === wanted || bare.endsWith('::' + wanted));
}
