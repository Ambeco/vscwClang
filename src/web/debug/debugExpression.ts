/**
 * Evaluates the small C-like expressions of breakpoint conditions, logpoints and Watch (`i == 3 && p.x > 2`); vscode-free.
 *
 * lldb's reactor only formats variable paths, so this evaluates everything around them itself: integer, float and
 * `true`/`false` literals, variable paths (`x`, `p.y`, `q->next`, `arr[2]`, `arr[i]`), parentheses, `! - + * / %`,
 * `< <= > >= == !=` and `&& ||` with C precedence. `resolve` supplies a path's value; anything else (calls, casts,
 * `*p`, `&x`, strings, assignment) throws with a suggestion instead of guessing. Integer division truncates toward
 * zero like C, and `&&`/`||` short-circuit, so `p != 0 && p->x > 1` never reads through a null `p`.
 */

export type ExprValue = number | boolean;

type Token = { kind: 'num'; value: number } | { kind: 'path'; text: string } | { kind: 'op'; text: string };

const PATH = /^[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*|\s*\[[^\]]*\])*/;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)[uUlLfF]*/;
const OPERATORS = ['&&', '||', '<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')'];

const SUPPORTED = ' Conditions support variable paths (x, p.y, q->z, a[2]), numbers, true/false, ! - * / % + - < <= > >= == != && || and parentheses; did you mean to compare a member instead of a call, cast, dereference or string?';

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let rest = source;
	for (;;) {
		rest = rest.trimStart();
		if (rest === '') { return tokens; }
		const number = NUMBER.exec(rest);
		if (number) {
			tokens.push({ kind: 'num', value: Number(number[0].replace(/[uUlLfF]+$/, '')) });
			rest = rest.slice(number[0].length);
			continue;
		}
		const path = PATH.exec(rest);
		if (path) {
			tokens.push({ kind: 'path', text: path[0] });
			rest = rest.slice(path[0].length);
			continue;
		}
		const op = OPERATORS.find(o => rest.startsWith(o));
		if (!op) {
			throw new Error(`vscwClang: cannot evaluate "${source}": unsupported text at "${rest.slice(0, 12)}".${SUPPORTED}`);
		}
		tokens.push({ kind: 'op', text: op });
		rest = rest.slice(op.length);
	}
}

const num = (v: ExprValue): number => typeof v === 'boolean' ? (v ? 1 : 0) : v;
const truthy = (v: ExprValue): boolean => typeof v === 'boolean' ? v : v !== 0;

/** `resolve` is called with the path text of each variable the expression actually reads. */
export function evaluateExpression(source: string, resolve: (path: string) => ExprValue): ExprValue {
	const tokens = tokenize(source);
	let at = 0;
	const fail = (what: string): never => { throw new Error(`vscwClang: cannot evaluate "${source}": ${what}.${SUPPORTED}`); };
	const peekOp = (...ops: string[]): string | undefined => {
		const t = tokens[at];
		return t && t.kind === 'op' && ops.includes(t.text) ? t.text : undefined;
	};

	// While `skip` is above zero the parser only consumes tokens: paths are not resolved and division by zero is ignored.
	let skip = 0;
	const binary = (next: () => ExprValue, ops: string[], apply: (op: string, l: ExprValue, r: ExprValue) => ExprValue): (() => ExprValue) => () => {
		let left = next();
		for (let op = peekOp(...ops); op; op = peekOp(...ops)) {
			at++;
			const right = next();
			left = apply(op, left, right);
		}
		return left;
	};

	const primary = (): ExprValue => {
		const t = tokens[at++];
		if (!t) { return fail('the expression ends early'); }
		if (t.kind === 'num') { return t.value; }
		if (t.kind === 'path') {
			if (t.text === 'true') { return true; }
			if (t.text === 'false') { return false; }
			return skip > 0 ? 0 : resolve(t.text.replace(/\s+/g, ''));
		}
		if (t.text === '(') {
			const v = or();
			if (!peekOp(')')) { fail('a ")" is missing'); }
			at++;
			return v;
		}
		return fail(`unexpected "${t.text}"`);
	};
	const unary = (): ExprValue => {
		const op = peekOp('!', '-', '+');
		if (!op) { return primary(); }
		at++;
		const v = unary();
		return op === '!' ? !truthy(v) : op === '-' ? -num(v) : num(v);
	};
	const mul = binary(unary, ['*', '/', '%'], (op, l, r) => {
		const [a, b] = [num(l), num(r)];
		if (op === '*') { return a * b; }
		if (b === 0 && skip === 0) { return fail('division by zero'); }
		const q = Number.isInteger(a) && Number.isInteger(b);
		return op === '/' ? (q ? Math.trunc(a / b) : a / b) : a % b;
	});
	const add = binary(mul, ['+', '-'], (op, l, r) => op === '+' ? num(l) + num(r) : num(l) - num(r));
	const rel = binary(add, ['<=', '>=', '<', '>'], (op, l, r) => { const [a, b] = [num(l), num(r)]; return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b; });
	const eq = binary(rel, ['==', '!='], (op, l, r) => (num(l) === num(r)) === (op === '=='));
	const and = (): ExprValue => {
		let left = eq();
		while (peekOp('&&')) {
			at++;
			const short = !truthy(left);
			if (short) { skip++; }
			const right = eq();
			if (short) { skip--; }
			left = !short && truthy(left) && truthy(right);
		}
		return left;
	};
	const or = (): ExprValue => {
		let left = and();
		while (peekOp('||')) {
			at++;
			const short = truthy(left);
			if (short) { skip++; }
			const right = and();
			if (short) { skip--; }
			left = short || truthy(right);
		}
		return left;
	};

	const value = or();
	if (at < tokens.length) { fail(`unexpected "${(tokens[at] as { text?: string }).text ?? 'number'}" after the expression`); }
	return value;
}

/** True when `source` is a lone variable path, which lldb can format itself (with its type and children). */
export function isPlainPath(source: string): boolean {
	const m = PATH.exec(source.trim());
	return m !== null && m[0].length === source.trim().length && source.trim() !== 'true' && source.trim() !== 'false';
}

/** The scalar in lldb's `(type) name = value` text: `1`, `97 'a'`, `1.5`, `0x0000ff`, `true`; throws for aggregates. */
export function scalarFromFormatted(path: string, formatted: string): ExprValue {
	const at = formatted.indexOf(' = ');
	const text = at < 0 ? formatted : formatted.slice(at + 3).trim();
	if (/^true\b/.test(text)) { return true; }
	if (/^false\b/.test(text)) { return false; }
	const m = /^[-+]?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)/.exec(text);
	if (!m) { throw new Error(`vscwClang: "${path}" is not a number, bool or pointer (lldb shows ${JSON.stringify(text.slice(0, 40))}); did you mean to compare one of its members?`); }
	return Number(m[0]);
}

/** Hit-count test for `hitCondition`: `N`, `== N`, `>= N`, `> N`, `<= N`, `< N`, `% N` (every Nth). */
export function hitConditionMatches(hitCondition: string, hits: number): boolean {
	const m = /^\s*(==|>=|<=|>|<|%)?\s*(\d+)\s*$/.exec(hitCondition);
	if (!m) { throw new Error(`vscwClang: cannot read the hit count "${hitCondition}"; did you mean a number such as 5, or ">= 5", "% 3"?`); }
	const n = Number(m[2]);
	switch (m[1]) {
		case '>': return hits > n;
		case '>=': return hits >= n;
		case '<': return hits < n;
		case '<=': return hits <= n;
		case '%': return n > 0 && hits % n === 0;
		default: return hits === n;
	}
}

/** Fills a logpoint's `{expression}` parts; `\{` and `\}` are literal braces. */
export function formatLogMessage(template: string, evaluate: (expression: string) => string): string {
	return template.replace(/\\([{}])|\{([^{}]*)\}/g, (_all, escaped: string | undefined, expression: string | undefined) => escaped ?? evaluate(expression!.trim()));
}
