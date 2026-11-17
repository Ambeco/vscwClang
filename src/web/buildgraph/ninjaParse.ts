/**
 * Reads Ninja manifests (`build.ninja`) into rules, build edges and defaults. Vscode-free.
 *
 * Covers what CMake and Meson write: `rule`, `build` (explicit, implicit `|` and order-only `||` inputs, implicit
 * outputs), `default`, top-level and indented bindings, `include` and `subninja` (resolved through the `readFile`
 * callback, relative to the including file), `pool` and `ninja_required_version` (ignored), `$` escapes (`$$`, `$ `,
 * `$:`, `${name}`, a trailing `$` joining lines) and comments. Top-level variables and build-line paths are expanded
 * when read; a rule's bindings stay raw until `expandCommand` has the edge's `$in` and `$out`. Anything else throws
 * `NinjaParseError` with the line, never skipped silently.
 *
 * `subninja` files get their own variable scope but their rules and edges join the one manifest: rule names that
 * clash between scopes are not supported and throw.
 */
export class NinjaParseError extends Error {}

export interface NinjaRule {
	name: string;
	/** Raw (unexpanded) bindings: `command`, `rspfile`, `rspfile_content`, `generator`, ... */
	bindings: Record<string, string>;
}

export interface NinjaEdge {
	rule: string;
	outputs: string[];
	implicitOutputs: string[];
	inputs: string[];
	implicitInputs: string[];
	orderOnlyInputs: string[];
	/** Edge-level bindings, already expanded. */
	bindings: Record<string, string>;
	/** Variables of the file scope the edge was declared in. */
	scope: Scope;
	/** `file:line` for messages. */
	where: string;
}

export interface NinjaManifest {
	rules: Map<string, NinjaRule>;
	edges: NinjaEdge[];
	defaults: string[];
}

export type Scope = Map<string, string>;

export type ReadFile = (path: string) => string;

const BUILTIN_RULES = ['phony'];
const SIMPLE_NAME = /[A-Za-z0-9_-]/;

/** @helper Parses `text` (the contents of `path`) into a manifest; `readFile` serves `include` and `subninja` and throws for a missing file. */
export function parseNinja(text: string, path: string, readFile: ReadFile): NinjaManifest {
	const manifest: NinjaManifest = { rules: new Map(), edges: [], defaults: [] };
	parseFile(manifest, text, path, readFile, new Map(), 0);
	return manifest;
}

function logicalLines(text: string): { text: string; line: number }[] {
	const out: { text: string; line: number }[] = [];
	const raw = text.split(/\r?\n/);
	for (let i = 0; i < raw.length; i++) {
		let current = raw[i];
		const start = i + 1;
		while (/(^|[^$])(\$\$)*\$$/.test(current) && i + 1 < raw.length) {
			current = current.slice(0, -1) + raw[++i].replace(/^\s+/, '');
		}
		out.push({ text: current, line: start });
	}
	return out;
}

/** Expands `$name`, `${name}`, `$$`, `$ ` and `$:` in `value`; `lookup` returns the already-expanded value, or undefined for an unset variable (empty). */
export function expandNinja(value: string, lookup: (name: string) => string | undefined, where: string): string {
	let out = '';
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c !== '$') { out += c; continue; }
		const next = value[++i];
		if (next === '$' || next === ' ' || next === ':') { out += next; continue; }
		let name: string;
		if (next === '{') {
			const end = value.indexOf('}', i);
			if (end < 0) { throw new NinjaParseError(`vscwClang: ${where}: unterminated \`\${\` in \`${value.slice(0, 80)}\`. Did you mean to close it with '}'?`); }
			name = value.slice(i + 1, end);
			i = end;
		} else {
			let j = i;
			while (j < value.length && SIMPLE_NAME.test(value[j])) { j++; }
			name = value.slice(i, j);
			if (name === '') { throw new NinjaParseError(`vscwClang: ${where}: a lone '$' in \`${value.slice(0, 80)}\`. Did you mean '$$' for a literal dollar sign?`); }
			i = j - 1;
		}
		const found = lookup(name);
		out += found ?? '';
	}
	return out;
}

/** Splits a build or default line into tokens at unescaped spaces, keeping `$ ` and `$:` escapes for `expandNinja`. */
function tokens(line: string): string[] {
	const found: string[] = [];
	let current = '';
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '$' && i + 1 < line.length) { current += c + line[++i]; continue; }
		if (c === ' ' || c === '\t') { if (current !== '') { found.push(current); current = ''; } continue; }
		current += c;
	}
	if (current !== '') { found.push(current); }
	return found;
}

function parseFile(m: NinjaManifest, text: string, path: string, readFile: ReadFile, scope: Scope, depth: number): void {
	if (depth > 20) { throw new NinjaParseError(`vscwClang: ${path}: include nesting is deeper than 20 files. Did you mean to remove an include cycle?`); }
	const lines = logicalLines(text);
	const dir = path.replace(/[/\\][^/\\]*$/, '');
	const resolve = (p: string) => (/^([A-Za-z]:)?[/\\]/.test(p) || dir === path ? p : `${dir}/${p}`);
	const lookup = (name: string) => scope.get(name);
	let i = 0;
	const bindingsBlock = (): { key: string; value: string; line: number }[] => {
		const found: { key: string; value: string; line: number }[] = [];
		while (i < lines.length && /^[ \t]+\S/.test(lines[i].text) && !lines[i].text.trim().startsWith('#')) {
			const m2 = /^[ \t]+([A-Za-z0-9_.-]+)[ \t]*=[ \t]*(.*)$/.exec(lines[i].text);
			if (!m2) { throw new NinjaParseError(`vscwClang: ${path}:${lines[i].line}: expected an indented \`name = value\`, found \`${lines[i].text.trim().slice(0, 80)}\`. Did you mean to fix the manifest or regenerate it?`); }
			found.push({ key: m2[1], value: m2[2], line: lines[i].line });
			i++;
		}
		return found;
	};
	while (i < lines.length) {
		const { text: raw, line } = lines[i++];
		const where = `${path}:${line}`;
		const trimmed = raw.trim();
		if (trimmed === '' || trimmed.startsWith('#')) { continue; }
		if (/^[ \t]/.test(raw)) { throw new NinjaParseError(`vscwClang: ${where}: an indented line with no statement above it: \`${trimmed.slice(0, 80)}\`. Did you mean to regenerate the manifest?`); }
		const keyword = /^[A-Za-z_]+/.exec(trimmed)?.[0] ?? '';
		const rest = trimmed.slice(keyword.length).replace(/^[ \t]+/, '');
		if (keyword === 'rule' && /^\S+$/.test(rest) && !/^=/.test(rest)) {
			if (m.rules.has(rest) || BUILTIN_RULES.includes(rest)) { throw new NinjaParseError(`vscwClang: ${where}: rule '${rest}' is defined twice. Did you mean to rename one of them?`); }
			const rule: NinjaRule = { name: rest, bindings: {} };
			for (const b of bindingsBlock()) { rule.bindings[b.key] = b.value; }
			m.rules.set(rest, rule);
		} else if (keyword === 'build') {
			parseBuild(m, rest, bindingsBlock(), scope, where);
		} else if (keyword === 'default') {
			m.defaults.push(...tokens(rest).map(t => expandNinja(t, lookup, where)));
		} else if (keyword === 'include' || keyword === 'subninja') {
			const file = resolve(expandNinja(rest, lookup, where));
			let included: string;
			try { included = readFile(file); } catch (e) {
				throw new NinjaParseError(`vscwClang: ${where}: cannot read ${keyword}d file '${file}': ${(e as Error).message}. Did you mean to open the folder the build directory was generated in, with its CMakeFiles folder?`);
			}
			parseFile(m, included, file, readFile, keyword === 'include' ? scope : new Map(scope), depth + 1);
		} else if (keyword === 'pool') {
			bindingsBlock();
		} else if (keyword === 'ninja_required_version') {
			continue;
		} else {
			const assign = /^([A-Za-z0-9_.-]+)[ \t]*=[ \t]*(.*)$/.exec(trimmed);
			if (!assign) { throw new NinjaParseError(`vscwClang: ${where}: unrecognised statement \`${trimmed.slice(0, 80)}\`. Did you mean to regenerate the manifest with a current Ninja or CMake?`); }
			scope.set(assign[1], expandNinja(assign[2], lookup, where));
		}
	}
}

function parseBuild(m: NinjaManifest, rest: string, block: { key: string; value: string; line: number }[], scope: Scope, where: string): void {
	const parts = tokens(rest);
	const colon = parts.findIndex(p => p === ':');
	const colonAt = colon >= 0 ? colon : parts.findIndex(p => /(^|[^$])(\$\$)*:$/.test(p));
	if (colon < 0 && colonAt < 0) { throw new NinjaParseError(`vscwClang: ${where}: a build statement needs a ':' after its outputs, found \`${rest.slice(0, 80)}\`. Did you mean to regenerate the manifest?`); }
	const lookup = (name: string) => scope.get(name);
	const left = colon >= 0 ? parts.slice(0, colon) : [...parts.slice(0, colonAt), parts[colonAt].slice(0, -1)].filter(p => p !== '');
	const right = colon >= 0 ? parts.slice(colon + 1) : parts.slice(colonAt + 1);
	const expand = (t: string) => expandNinja(t, lookup, where);
	const outputs: string[] = [];
	const implicitOutputs: string[] = [];
	let target = outputs;
	for (const t of left) { if (t === '|') { target = implicitOutputs; } else { target.push(expand(t)); } }
	const rule = right[0] === undefined ? '' : expand(right[0]);
	if (rule === '') { throw new NinjaParseError(`vscwClang: ${where}: a build statement has no rule after ':'. Did you mean 'phony' or a rule name?`); }
	if (rule !== 'phony' && !m.rules.has(rule)) {
		const known = [...m.rules.keys()].slice(0, 5).join(', ');
		throw new NinjaParseError(`vscwClang: ${where}: unknown rule '${rule}'. Did you mean one of ${known || 'phony'}? (A rule must be defined before the build statement that uses it.)`);
	}
	const inputs: string[] = [];
	const implicitInputs: string[] = [];
	const orderOnlyInputs: string[] = [];
	let into = inputs;
	for (const t of right.slice(1)) {
		if (t === '|') { into = implicitInputs; } else if (t === '||') { into = orderOnlyInputs; } else if (t === '|@') { into = implicitInputs; } else { into.push(expand(t)); }
	}
	const bindings: Record<string, string> = {};
	for (const b of block) { bindings[b.key] = expandNinja(b.value, n => bindings[n] ?? scope.get(n), where); }
	m.edges.push({ rule, outputs, implicitOutputs, inputs, implicitInputs, orderOnlyInputs, bindings, scope, where });
}

const SAFE_WORD = /^[\w@%+=:,./-]+$/;
const quote = (p: string) => SAFE_WORD.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command of `edge`: its rule's `command` with `$in`, `$out`, edge bindings and file variables expanded.
 * A `@<rspfile>` argument is replaced by the rule's `rspfile_content`, since lines are classified, not run.
 */
export function expandCommand(manifest: NinjaManifest, edge: NinjaEdge): string {
	const rule = manifest.rules.get(edge.rule);
	if (rule === undefined) { throw new NinjaParseError(`vscwClang: ${edge.where}: '${edge.rule}' has no command to run. Did you mean a phony alias?`); }
	const builtin: Record<string, string> = {
		in: edge.inputs.map(quote).join(' '),
		in_newline: edge.inputs.join('\n'),
		out: edge.outputs.map(quote).join(' '),
	};
	const inProgress = new Set<string>();
	const lookup = (name: string): string | undefined => {
		const direct = builtin[name] ?? edge.bindings[name];
		if (direct !== undefined) { return direct; }
		const raw = rule.bindings[name];
		if (raw === undefined) { return edge.scope.get(name); }
		if (inProgress.has(name)) { throw new NinjaParseError(`vscwClang: ${edge.where}: rule '${rule.name}' binding '${name}' refers to itself. Did you mean to rename the edge variable it should read?`); }
		inProgress.add(name);
		try { return expandNinja(raw, lookup, edge.where); } finally { inProgress.delete(name); }
	};
	const command = rule.bindings.command;
	if (command === undefined) { throw new NinjaParseError(`vscwClang: ${edge.where}: rule '${rule.name}' has no command. Did you mean to regenerate the manifest?`); }
	let text = expandNinja(command, lookup, edge.where).trim();
	const rspfile = rule.bindings.rspfile === undefined ? undefined : expandNinja(rule.bindings.rspfile, lookup, edge.where);
	if (rspfile !== undefined && rule.bindings.rspfile_content !== undefined) {
		const content = expandNinja(rule.bindings.rspfile_content, lookup, edge.where).trim();
		text = text.split(`@${rspfile}`).join(content);
	}
	return text;
}
