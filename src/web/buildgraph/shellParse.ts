/**
 * Parses one POSIX shell line (a make recipe line, a Ninja `command`) into simple commands. Vscode-free.
 *
 * Supported: single and double quotes, backslash escapes and line continuations, `&&`, `||`, `;`, `VAR=value`
 * prefixes, `>`, `>>`, `2>`, `2>>` and `2>&1` redirections, `#` comments, and unquoted glob characters (flagged on
 * the word; expanding them is the consumer's job). Everything else (pipes, `&`, `<`, subshells, `if`/`for`/`while`/
 * `case`, variable and command substitution, here-documents) throws `ShellSyntaxError`: the build graph must never
 * guess what a recipe line meant. Make has already expanded its own `$(VAR)`s, so a `$` that reaches the shell is
 * the shell's own and is rejected.
 */
export class ShellSyntaxError extends Error {}

export interface ShellWord {
	text: string;
	/** An unquoted `*`, `?` or `[` appeared in the word. */
	glob: boolean;
}

export interface ShellRedirect {
	fd: 1 | 2;
	op: '>' | '>>';
	/** `/dev/null` is kept as written; a duplicate such as `2>&1` has `dupOf` set and no target. */
	target?: string;
	dupOf?: 1 | 2;
}

export interface SimpleCommand {
	assignments: Record<string, string>;
	argv: ShellWord[];
	redirects: ShellRedirect[];
}

export interface ShellItem {
	command: SimpleCommand;
	/** How this item is joined to the previous one; undefined for the first. */
	joinedBy?: '&&' | '||' | ';';
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', '{', '}', '!']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function fail(line: string, why: string, suggestion: string): never {
	throw new ShellSyntaxError(`vscwClang: cannot read shell line \`${line}\`: ${why}. Did you mean ${suggestion}?`);
}

function rejectKeyword(line: string, keyword: string): never {
	fail(line, `shell control syntax \`${keyword}\` is not supported`, 'separate commands joined with `&&`, or a Makefile without shell loops/conditionals');
}

interface Token { kind: 'word'; word: ShellWord; quoted: boolean; assignment: boolean }
interface OperatorToken { kind: 'op'; op: string }

function tokenize(line: string): (Token | OperatorToken)[] {
	const tokens: (Token | OperatorToken)[] = [];
	let text = '';
	let glob = false;
	let quoted = false;
	let inWord = false;
	let plainPrefix: string | undefined;
	const flush = () => {
		if (inWord) { tokens.push({ kind: 'word', word: { text, glob }, quoted, assignment: ASSIGNMENT.test(plainPrefix ?? text) }); }
		text = ''; glob = false; quoted = false; inWord = false; plainPrefix = undefined;
	};
	const startQuote = () => { plainPrefix ??= text; };
	const rejectDollar = (next: string | undefined) => {
		if (next === '(') { fail(line, 'command or arithmetic substitution `$(...)` is not supported', 'a Makefile that expands it with $(shell ...) or writes the value out'); }
		if (next === '{') { fail(line, 'shell parameter expansion `${...}` is not supported', 'the value written into the command'); }
		fail(line, 'shell variables (`$NAME`) are not supported', 'a make variable ($(NAME)), which make expands before the shell sees it');
	};
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) { fail(line, "unterminated single quote", "to add a closing '"); }
			startQuote(); text += line.slice(i + 1, end); inWord = true; quoted = true; i = end;
		} else if (c === '"') {
			startQuote(); inWord = true; quoted = true;
			let closed = false;
			for (i++; i < line.length; i++) {
				const d = line[i];
				if (d === '"') { closed = true; break; }
				if (d === '\\' && i + 1 < line.length) {
					const next = line[i + 1];
					if (next === '\n') { i++; } else if ('"\\$`'.includes(next)) { text += next; i++; } else { text += d; }
				} else if (d === '$') {
					rejectDollar(line[i + 1]);
				} else if (d === '`') {
					fail(line, 'backtick command substitution is not supported', 'a Makefile that expands it with $(shell ...)');
				} else {
					text += d;
				}
			}
			if (!closed) { fail(line, 'unterminated double quote', 'to add a closing "'); }
		} else if (c === '\\') {
			if (i + 1 >= line.length) { fail(line, 'a trailing backslash', 'to remove it or continue the command'); }
			const next = line[++i];
			if (next !== '\n') { text += next; inWord = true; quoted = true; }
		} else if (c === '$') {
			rejectDollar(line[i + 1]);
		} else if (c === '`') {
			fail(line, 'backtick command substitution is not supported', 'a Makefile that expands it with $(shell ...)');
		} else if (c === '#' && !inWord) {
			while (i < line.length && line[i] !== '\n') { i++; }
		} else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			if (c === '\n') { flush(); tokens.push({ kind: 'op', op: ';' }); } else { flush(); }
		} else if (c === '&' || c === '|' || c === ';' || c === '>' || c === '<' || c === '(' || c === ')') {
			const two = line.slice(i, i + 2);
			if (c === '>' && inWord && !quoted && (text === '1' || text === '2')) {
				const fd = text; text = ''; inWord = false;
				const op = line[i + 1] === '>' ? '>>' : '>';
				if (line[i + op.length] === '&') {
					const target = line[i + op.length + 1];
					if ((target !== '1' && target !== '2') || op === '>>') { fail(line, `unsupported descriptor redirection \`${fd}${op}&${target ?? ''}\``, '`2>&1`'); }
					tokens.push({ kind: 'op', op: `${fd}>&${target}` }); i += op.length + 1;
				} else {
					tokens.push({ kind: 'op', op: `${fd}${op}` }); i += op.length - 1;
				}
			} else if (two === '&&' || two === '||' || two === '>>') {
				flush(); tokens.push({ kind: 'op', op: two }); i++;
			} else if (c === '>' && line[i + 1] === '&') {
				fail(line, 'unsupported `>&` redirection', '`> file 2>&1`');
			} else if (c === '<') {
				fail(line, line[i + 1] === '<' ? 'here-documents are not supported' : 'input redirection `<` is not supported', 'the command taking the file name as an argument');
			} else if (c === '|') {
				fail(line, 'pipelines are not supported', 'a command that writes to a file with `>` and a separate step');
			} else if (c === '&') {
				fail(line, 'background jobs (`&`) are not supported', 'running the command in the foreground');
			} else if (c === '(' || c === ')') {
				fail(line, 'subshells are not supported', 'the commands joined with `&&`');
			} else {
				flush(); tokens.push({ kind: 'op', op: c });
			}
		} else {
			if (c === '*' || c === '?' || c === '[') { glob = true; }
			text += c; inWord = true;
		}
	}
	flush();
	return tokens;
}

/** @helper Splits one shell line into commands joined by `&&`, `||` and `;`; throws `ShellSyntaxError` on anything unsupported. */
export function parseShellLine(line: string): ShellItem[] {
	const items: ShellItem[] = [];
	let current: SimpleCommand = { assignments: {}, argv: [], redirects: [] };
	let joinedBy: ShellItem['joinedBy'];
	let tokens: (Token | OperatorToken)[];
	try {
		tokens = tokenize(line);
	} catch (e) {
		const first = /^\s*([A-Za-z_]+)(?=\s|$)/.exec(line)?.[1];
		if (first !== undefined && KEYWORDS.has(first)) { rejectKeyword(line, first); }
		throw e;
	}
	const finish = (op?: '&&' | '||' | ';') => {
		const empty = current.argv.length === 0 && current.redirects.length === 0 && Object.keys(current.assignments).length === 0;
		if (empty) {
			if (op === '&&' || op === '||') { fail(line, `\`${op}\` has no command before it`, 'a command before the operator'); }
			if (op === undefined && (joinedBy === '&&' || joinedBy === '||')) { fail(line, `\`${joinedBy}\` has no command after it`, 'a command after the operator'); }
			return;
		}
		if (current.argv.length === 0) {
			if (current.redirects.length > 0) { fail(line, 'a redirection with no command', "`: > file` to create or empty a file"); }
			fail(line, 'a bare variable assignment sets a shell variable, which a build graph cannot track', 'a make variable, or `VAR=value command` on one command');
		}
		items.push({ command: current, joinedBy });
		current = { assignments: {}, argv: [], redirects: [] };
		joinedBy = op;
	};
	for (let t = 0; t < tokens.length; t++) {
		const token = tokens[t];
		if (token.kind === 'word') {
			if (current.argv.length === 0 && token.assignment) {
				const eq = token.word.text.indexOf('=');
				current.assignments[token.word.text.slice(0, eq)] = token.word.text.slice(eq + 1);
			} else {
				if (current.argv.length === 0 && !token.quoted && KEYWORDS.has(token.word.text)) {
					rejectKeyword(line, token.word.text);
				}
				current.argv.push(token.word);
			}
			continue;
		}
		const { op } = token;
		if (op === '&&' || op === '||' || op === ';') { finish(op); continue; }
		const fd = (op.startsWith('2') ? 2 : 1) as 1 | 2;
		const dup = /^([12])>&([12])$/.exec(op);
		if (dup) { current.redirects.push({ fd: Number(dup[1]) as 1 | 2, op: '>', dupOf: Number(dup[2]) as 1 | 2 }); continue; }
		const target = tokens[++t];
		if (target === undefined || target.kind !== 'word') { fail(line, `redirection \`${op}\` has no file name`, `\`${op} file\``); }
		current.redirects.push({ fd, op: op.endsWith('>>') ? '>>' : '>', target: target.word.text });
	}
	finish();
	if (items.length === 0 && line.trim() !== '' && !/^\s*#/.test(line) && !/^[\s;]*$/.test(line)) {
		fail(line, 'no command found', 'a command name');
	}
	return items;
}
