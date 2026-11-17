import { checkUserFlags } from '../toolchain/flagPolicy';
import { GUEST_WORKSPACE } from '../toolchain/guestPaths';
import { describeUnmappableCommand, hostToGuest, mapArgs, ProjectModelError } from '../toolchain/projectModel';
import { parseShellLine, type ShellRedirect, type SimpleCommand } from './shellParse';

/**
 * Maps shell command lines (make recipes, Ninja `command`s) onto build actions instead of running them.
 *
 * A recognised tool becomes an action the build graph can hold: a compiler driver becomes `compile` (`-c`) or `link`,
 * `ar` becomes `archive`, and a small set of coreutils (`mkdir`, `rm`, `cp`, `mv`, `touch`, `echo`/`printf` redirected
 * to a file, `cd`) become file actions. Compiler flags go through `mapArgs` and `checkUserFlags` like `tasks.json`
 * and `compile_commands.json` do; flags the sandbox forbids (`--target`, `--sysroot`, `-fuse-ld`, `-B`, `-march`) are
 * dropped with a note. All paths are guest paths (`/workspace/...`); absolute host paths are rebased with `hostRoot`.
 *
 * `&&` and `;` run the next command after the previous one, `cd` changes the directory for the rest of the line, and
 * `cmd || true` marks `cmd` as allowed to fail. Any other `||`, an unknown command, or an unsupported option throws
 * `ClassifyError` naming the command, with a did-you-mean suggestion, so nothing is silently skipped.
 */
export class ClassifyError extends Error {}

export interface ClassifyContext {
	/** Guest directory the line starts in. */
	cwd: string;
	/** Host path of the workspace folder, to rebase absolute host paths (see `inferHostRoot`). */
	hostRoot?: string;
}

interface Common { ignoreFailure?: boolean; command: string }
export type BuildAction = Common & (
	| { kind: 'compile'; source: string; output: string; flags: string[] }
	/** `flags` mixes compile flags with `-l`, `-L` and `-Wl,` flags, as `BuildRequest.flags` takes them. */
	| { kind: 'link'; inputs: string[]; output: string; flags: string[] }
	| { kind: 'archive'; output: string; members: string[] }
	| { kind: 'mkdir'; paths: string[] }
	/** `paths` may hold `*`, `?` and `[` patterns (`glob`). */
	| { kind: 'remove'; paths: string[]; glob: boolean; recursive: boolean }
	| { kind: 'copy'; from: string[]; to: string; recursive: boolean }
	| { kind: 'move'; from: string; to: string }
	| { kind: 'touch'; paths: string[] }
	| { kind: 'write'; path: string; text: string; append: boolean }
	/** A command with no effect on the build (`true`, `ranlib`, `echo` to the log). */
	| { kind: 'noop'; reason: string }
);

export interface ClassifiedLine {
	actions: BuildAction[];
	notes: string[];
	/** Directory after the line, so a following line in the same shell could continue from it. */
	cwd: string;
}

const KNOWN_COMMANDS = ['cc', 'c++', 'gcc', 'g++', 'clang', 'clang++', 'ar', 'ranlib', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'echo', 'printf', 'true', 'cd', ':'];
const OBJECT_INPUT = /\.(o|obj|a|lo)$/i;
const FORBIDDEN_FLAG = /^(--target(=.*)?|-target|--sysroot(=.*)?|-isysroot|-fuse-ld=.*|-B.*|-march=.*|-mcpu=.*|-fplugin.*)$/;
const FORBIDDEN_VALUE_FLAG = /^(--target|-target|--sysroot|-isysroot)$/;

function levenshtein(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = next;
		}
	}
	return row[b.length];
}

function unknownCommand(name: string, line: string): ClassifyError {
	const close = KNOWN_COMMANDS.filter(k => levenshtein(name, k) <= (name.length <= 4 ? 1 : 2)).sort((a, b) => levenshtein(name, a) - levenshtein(name, b))[0];
	const hint = close !== undefined
		? `Did you mean '${close}'?`
		: `Supported are ${KNOWN_COMMANDS.join(', ')}. Did you mean to run this step on a desktop and commit its output, or to replace it with one of those?`;
	return new ClassifyError(`vscwClang: cannot map the command '${name}' in \`${line}\`: the browser build runs no programs of its own. ${hint}`);
}

const baseName = (command: string) => (command.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '');

/** @helper Maps one shell line (a make recipe line, a Ninja command) onto build actions; throws `ClassifyError` on anything it cannot map exactly. */
export function classifyShellLine(line: string, ctx: ClassifyContext): ClassifiedLine {
	const notes: string[] = [];
	const actions: BuildAction[] = [];
	let cwd = ctx.cwd;
	const items = parseShellLine(line);
	for (const item of items) {
		const { command } = item;
		const name = baseName(command.argv[0].text);
		const text = command.argv.map(w => w.text).join(' ');
		if (item.joinedBy === '||') {
			if (name !== 'true' && name !== ':') {
				throw new ClassifyError(`vscwClang: cannot map \`${line}\`: \`||\` is only supported as \`command || true\` (ignore failure), since a build graph has no run-time branches. Did you mean to run '${text}' as its own recipe line?`);
			}
			if (actions.length > 0) { actions[actions.length - 1].ignoreFailure = true; }
			continue;
		}
		const ctxNow: ClassifyContext = { cwd, hostRoot: ctx.hostRoot };
		if (name === 'cd') {
			if (command.argv.length !== 2) { throw new ClassifyError(`vscwClang: 'cd' needs exactly one directory in \`${line}\`. Did you mean 'cd <dir> && ...'?`); }
			cwd = resolvePath(command.argv[1].text, ctxNow, line);
			continue;
		}
		const ignoredEnv = Object.keys(command.assignments);
		if (ignoredEnv.length > 0) { notes.push(`ignored environment ${ignoredEnv.join(', ')} for '${name}': programs run without extra environment variables`); }
		const classified = classifyCommand(command, name, text, ctxNow, line, notes);
		if (classified !== undefined) { actions.push(classified); }
	}
	return { actions, notes, cwd };
}

function resolvePath(path: string, ctx: ClassifyContext, line: string): string {
	const guest = hostToGuest(path, ctx.cwd, ctx.hostRoot ?? '/\0no-host-root');
	if (guest === undefined) {
		throw new ClassifyError(`vscwClang: '${path}' in \`${line}\` is outside the workspace folder, which is all a browser build can see. Did you mean a path under ${GUEST_WORKSPACE}?`);
	}
	return guest;
}

function classifyCommand(command: SimpleCommand, name: string, text: string, ctx: ClassifyContext, line: string, notes: string[]): BuildAction | undefined {
	const args = command.argv.slice(1).map(w => w.text);
	const path = (p: string) => resolvePath(p, ctx, line);
	const fileRedirect = command.redirects.find(r => r.fd === 1 && r.dupOf === undefined && r.target !== '/dev/null');
	const writesFiles = name === 'echo' || name === 'printf' || name === ':' || name === 'true';
	for (const r of command.redirects) {
		if (r.dupOf !== undefined || r.target === '/dev/null' || (r === fileRedirect && writesFiles)) { continue; }
		throw new ClassifyError(`vscwClang: cannot map \`${line}\`: redirecting '${name}' output to '${r.target}' is only supported for echo, printf and ':', and 2> only to /dev/null. Did you mean to let '${name}' write the file itself (for example a -o option)?`);
	}
	const base = { command: text };
	if (/^(ccache|sccache|distcc)$/.test(name)) {
		return classifyCommand({ ...command, argv: command.argv.slice(1) }, baseName(command.argv[1]?.text ?? ''), command.argv.slice(1).map(w => w.text).join(' '), ctx, line, notes);
	}
	if (describeUnmappableCommand(name) === undefined) { return classifyCompiler(args, ctx, line, notes, base); }
	if (/(^|-)ar$/.test(name)) { return classifyArchive(args, path, line, base); }
	switch (name) {
		case 'ranlib': return { ...base, kind: 'noop', reason: 'archives need no index: wasm-ld reads them without one' };
		case 'true': case ':':
			return fileRedirect === undefined ? undefined : { ...base, kind: 'write', path: path(fileRedirect.target ?? ''), text: '', append: fileRedirect.op === '>>' };
		case 'echo': case 'printf': return classifyEcho(name, args, fileRedirect, path, line, base);
		case 'mkdir': {
			const dirs = args.filter(a => !a.startsWith('-'));
			const bad = args.find(a => a.startsWith('-') && a !== '-p' && a !== '-v');
			if (bad !== undefined) { throw new ClassifyError(`vscwClang: unsupported option '${bad}' for mkdir in \`${line}\`. Did you mean 'mkdir -p <dir>'?`); }
			if (dirs.length === 0) { throw new ClassifyError(`vscwClang: mkdir has no directory in \`${line}\`. Did you mean 'mkdir -p <dir>'?`); }
			return { ...base, kind: 'mkdir', paths: dirs.map(path) };
		}
		case 'rm': {
			const flags = args.filter(a => /^-[a-zA-Z]+$/.test(a)).map(a => a.slice(1)).join('');
			const bad = flags.replace(/[frRv]/g, '');
			if (bad !== '') { throw new ClassifyError(`vscwClang: unsupported option '-${bad[0]}' for rm in \`${line}\`. Did you mean 'rm -f' or 'rm -rf'?`); }
			const targets = command.argv.slice(1).filter(w => !/^-[a-zA-Z]+$/.test(w.text));
			return { ...base, kind: 'remove', paths: targets.map(w => path(w.text)), glob: targets.some(w => w.glob), recursive: /[rR]/.test(flags) };
		}
		case 'cp': case 'mv': {
			const flags = args.filter(a => /^-[a-zA-Z]+$/.test(a)).map(a => a.slice(1)).join('');
			const bad = flags.replace(/[frRpav]/g, '');
			if (bad !== '' || (name === 'mv' && /[rRpa]/.test(flags))) { throw new ClassifyError(`vscwClang: unsupported option for ${name} in \`${line}\`. Did you mean '${name} <from> <to>'?`); }
			const files = args.filter(a => !/^-[a-zA-Z]+$/.test(a));
			if (files.length < 2) { throw new ClassifyError(`vscwClang: ${name} needs a source and a destination in \`${line}\`. Did you mean '${name} <from> <to>'?`); }
			if (command.argv.some(w => w.glob)) { throw new ClassifyError(`vscwClang: ${name} with a wildcard in \`${line}\` is not supported. Did you mean to list the files?`); }
			if (name === 'mv') {
				if (files.length !== 2) { throw new ClassifyError(`vscwClang: mv with ${files.length - 1} sources in \`${line}\` is not supported. Did you mean one 'mv <from> <to>' per file?`); }
				return { ...base, kind: 'move', from: path(files[0]), to: path(files[1]) };
			}
			return { ...base, kind: 'copy', from: files.slice(0, -1).map(path), to: path(files[files.length - 1]), recursive: /[rRa]/.test(flags) };
		}
		case 'touch': return { ...base, kind: 'touch', paths: args.filter(a => !a.startsWith('-')).map(path) };
		case 'ln': throw new ClassifyError(`vscwClang: cannot map \`${line}\`: symbolic links do not exist in the browser file system. Did you mean 'cp' (a copy of the file)?`);
		case 'false': throw new ClassifyError(`vscwClang: cannot map \`${line}\`: 'false' always fails the build. Did you mean to remove the step?`);
		default: throw unknownCommand(name, line);
	}
}

function classifyEcho(name: string, args: string[], fileRedirect: ShellRedirect | undefined, path: (p: string) => string, line: string, base: { command: string }): BuildAction {
	let text: string;
	if (name === 'echo') {
		const noNewline = args[0] === '-n';
		const rest = noNewline ? args.slice(1) : args;
		if (rest[0] === '-e' || rest[0] === '-E') { throw new ClassifyError(`vscwClang: 'echo ${rest[0]}' in \`${line}\` is shell-specific. Did you mean plain 'echo' or 'printf' without escapes?`); }
		text = rest.join(' ') + (noNewline ? '' : '\n');
	} else {
		const [format = '', ...rest] = args;
		if (format.includes('%')) { throw new ClassifyError(`vscwClang: printf with a '%' format in \`${line}\` is not supported. Did you mean 'echo'?`); }
		if (rest.length > 0) { throw new ClassifyError(`vscwClang: printf with arguments in \`${line}\` is not supported. Did you mean to write the text into the format?`); }
		text = format.replace(/\\(n|t|\\)/g, (_m, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : '\\');
	}
	if (fileRedirect === undefined) { return { ...base, kind: 'noop', reason: `${name} to the build log` }; }
	return { ...base, kind: 'write', path: path(fileRedirect.target ?? ''), text, append: fileRedirect.op === '>>' };
}

function classifyArchive(args: string[], path: (p: string) => string, line: string, base: { command: string }): BuildAction {
	const [modes, output, ...members] = args;
	const letters = (modes ?? '').replace(/^-/, '');
	if (!/^[a-zA-Z]+$/.test(letters) || !/[rq]/.test(letters) || /[^rqcsuvDUTl]/.test(letters)) {
		throw new ClassifyError(`vscwClang: unsupported ar operation '${modes ?? ''}' in \`${line}\`. Did you mean 'ar rcs <archive> <objects>'?`);
	}
	if (output === undefined || members.length === 0) { throw new ClassifyError(`vscwClang: ar needs an archive and its members in \`${line}\`. Did you mean 'ar rcs <archive> <objects>'?`); }
	return { ...base, kind: 'archive', output: path(output), members: members.map(path) };
}

function classifyCompiler(rawArgs: string[], ctx: ClassifyContext, line: string, notes: string[], base: { command: string }): BuildAction {
	const args: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const a = rawArgs[i];
		if (FORBIDDEN_FLAG.test(a)) {
			const value = FORBIDDEN_VALUE_FLAG.test(a) ? ` ${rawArgs[++i] ?? ''}` : '';
			notes.push(`dropped '${a}${value}': the target, sysroot and linker are fixed by the toolchain`);
		} else {
			args.push(a);
		}
	}
	if (args.includes('-shared')) {
		throw new ClassifyError(`vscwClang: cannot map \`${line}\`: shared libraries (-shared) cannot be built or loaded in the browser. Did you mean a static library ('ar rcs lib<name>.a <objects>')?`);
	}
	const compileOnly = args.includes('-c');
	const sources: string[] = [];
	const objects: string[] = [];
	let mapped;
	try {
		mapped = mapArgs(args, `command \`${line}\``, {
			mapDir: dir => hostToGuest(dir, ctx.cwd, ctx.hostRoot ?? '/\0no-host-root'),
			onSource: a => { sources.push(resolvePath(a, ctx, line)); return undefined; },
			onOther: a => { if (!OBJECT_INPUT.test(a)) { return false; } objects.push(resolvePath(a, ctx, line)); return true; },
			database: true,
		});
	} catch (e) {
		if (e instanceof ProjectModelError) { throw new ClassifyError(e.message); }
		throw e;
	}
	notes.push(...mapped.notes);
	const problems = checkUserFlags(mapped.flags);
	if (problems.length > 0) { throw new ClassifyError(`vscwClang: \`${line}\`: ${problems.join(' ')}`); }
	if (compileOnly) {
		if (sources.length !== 1 || objects.length > 0) {
			throw new ClassifyError(`vscwClang: cannot map \`${line}\`: a compile step must name exactly one source file (found ${sources.length}). Did you mean one command per source?`);
		}
		const output = mapped.output === undefined ? `${ctx.cwd}/${sources[0].replace(/^.*\//, '').replace(/\.[^.]*$/, '')}.o` : resolvePath(mapped.output, ctx, line);
		return { ...base, kind: 'compile', source: sources[0], output, flags: mapped.flags };
	}
	const inputs = [...sources, ...objects];
	if (inputs.length === 0) {
		throw new ClassifyError(`vscwClang: cannot map \`${line}\`: the compiler has no input files. Did you mean to pass the objects or sources to link?`);
	}
	return { ...base, kind: 'link', inputs, output: mapped.output === undefined ? `${ctx.cwd}/a.out` : resolvePath(mapped.output, ctx, line), flags: mapped.flags };
}
