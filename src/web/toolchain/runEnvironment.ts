/** Guest paths of the writable directories every run gets. */
export const GUEST_TMP = '/tmp';
export const GUEST_HOME = '/home/user';

/**
 * The environment a program starts with: `HOME`, `TMPDIR`, `USER`, `LANG`, then `extra` (the `vscwclang.run.env`
 * setting), which wins. A value of `null` in `extra` removes a default.
 */
export function defaultRunEnvironment(extra: Record<string, string | null> = {}): Record<string, string> {
	const env: Record<string, string> = { HOME: GUEST_HOME, TMPDIR: GUEST_TMP, USER: 'user', LANG: 'C.UTF-8' };
	for (const [key, value] of Object.entries(extra)) {
		if (value === null) { delete env[key]; } else { env[key] = String(value); }
	}
	return env;
}

/**
 * Splits a command line into arguments the way a POSIX shell would for the common cases: whitespace separates,
 * single quotes are literal, double quotes group (with `\"` and `\\` escapes), and a backslash outside quotes
 * escapes the next character. No globbing, variables or redirection.
 *
 * Throws on an unterminated quote, with a suggestion.
 */
export function splitArgs(line: string): string[] {
	const args: string[] = [];
	let current = '';
	let inToken = false;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote === "'") {
			if (c === "'") { quote = undefined; } else { current += c; }
		} else if (quote === '"') {
			if (c === '"') { quote = undefined; }
			else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) { current += line[++i]; }
			else { current += c; }
		} else if (c === '"' || c === "'") {
			quote = c; inToken = true;
		} else if (c === '\\' && i + 1 < line.length) {
			current += line[++i]; inToken = true;
		} else if (/\s/.test(c)) {
			if (inToken) { args.push(current); current = ''; inToken = false; }
		} else {
			current += c; inToken = true;
		}
	}
	if (quote !== undefined) {
		throw new Error(`vscwClang: unterminated ${quote} in arguments "${line}". Did you mean to add a closing ${quote}?`);
	}
	if (inToken) { args.push(current); }
	return args;
}

/** Joins arguments back into a line that `splitArgs` reads as the same list (for pre-filling the prompt). */
export function joinArgs(args: readonly string[]): string {
	return args.map(a => (a !== '' && /^[\w@%+=:,./-]+$/.test(a)) ? a : `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}
