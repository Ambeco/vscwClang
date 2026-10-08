import { checkUserFlags } from './flagPolicy';
import { GUEST_WORKSPACE } from './guestPaths';
import { splitArgs } from './runEnvironment';

/**
 * Turns what a desktop VS Code project already contains (`tasks.json` compile tasks, `launch.json` configurations)
 * into this extension's build and run inputs. Vscode-free so it can be tested under Node.
 *
 * All paths are resolved to guest paths (`/workspace/...`), so desktop variables such as `${fileDirname}` and
 * `${workspaceFolder}` mean the same thing here as in the compiler's view of the workspace. Unknown variables
 * (`${input:...}`, `${command:...}`, `${env:...}`), unrecognized compilers and unmappable arguments throw
 * `ProjectModelError` with a did-you-mean suggestion instead of being skipped.
 *
 * Only the compiler's own command line is mapped; `tasks.json` tasks that run other programs (make, cmake, cl.exe)
 * are rejected. Flags the sandbox cannot honour (`-pthread`, `-static`, color flags) are dropped and listed in
 * `BuildPlan.notes`; flags it forbids (`-c`, `--target`, ...) are rejected by `checkUserFlags`.
 */
export class ProjectModelError extends Error {}

export interface VariableContext {
	/** Name of the workspace folder, for `${workspaceFolderBasename}`. */
	folderName: string;
	/** Workspace-relative path (forward slashes) of the active C/C++ file, if any. */
	file?: string;
}

export interface BuildPlan {
	/** Workspace-relative files or globs. */
	sources: string[];
	flags: string[];
	/** File name for the .wasm (placed by the artifact policy, not at the task's literal path); undefined means the default. */
	outputName?: string;
	mode: 'debug' | 'release';
	notes: string[];
}

export interface TaskLike {
	label?: unknown;
	type?: unknown;
	command?: unknown;
	args?: unknown;
	options?: { cwd?: unknown } | null;
	group?: unknown;
}

export interface TaskEntry {
	label: string;
	task: TaskLike;
	isDefaultBuild: boolean;
}

export interface LaunchEntry {
	name: string;
	/** Resolved `program`, or undefined if it uses a variable that cannot be resolved here. */
	program?: string;
	/** Undefined when the configuration has no `args` key, so other argument sources may apply. */
	args?: string[];
	preLaunchTask?: string;
}

const COMPILERS = new Set(['g++', 'gcc', 'c++', 'cc', 'clang', 'clang++']);
const LAUNCH_TYPES = new Set(['cppdbg', 'cppvsdbg', 'lldb', 'codelldb', 'vscwclang']);
const SOURCE_EXTENSION = /\.(c|cc|cpp|cxx|c\+\+|cp|C)$/;
const COLOR_FLAGS = /^(-fdiagnostics-color(=.*)?|-fcolor-diagnostics|-fansi-escape-codes|-fno-color-diagnostics|-fno-diagnostics-color)$/;
const DROPPED_FLAGS: Record<string, string> = {
	'-pthread': 'programs are single-threaded',
	'-lpthread': 'programs are single-threaded',
	'-static': 'every program is linked statically already',
	'-static-libgcc': 'every program is linked statically already',
	'-static-libstdc++': 'every program is linked statically already',
	'-lstdc++': 'the C++ standard library is linked automatically',
	'-mwindows': 'there are no Windows APIs',
	'-mconsole': 'there are no Windows APIs',
	'-m64': 'the target is always wasm32',
	'-m32': 'the target is always wasm32',
};
/** Flags whose next argument is their value and is not a path to map. */
const VALUE_FLAGS = new Set(['-x', '-D', '-U', '-l', '-include', '-imacros', '-Xlinker', '-Xclang', '-Xpreprocessor', '-Xassembler', '-MF', '-MT', '-MQ', '-idirafter']);
const PATH_FLAG = /^(-isystem|-iquote|-I|-L)(.*)$/;

/** Name without directory and without a trailing `.exe` or `.wasm`, so a desktop `-o`/`program` and our output compare equal. */
export function programStem(path: string): string {
	return (path.replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.(exe|wasm)$/i, '');
}

function unknownVariable(name: string): ProjectModelError {
	const hint = /^(input|command|env|config):/.test(name)
		? `'\${${name}}' needs VS Code to evaluate it, which this extension does not do. Did you mean to write the value into the file?`
		: `Did you mean one of \${workspaceFolder}, \${file}, \${fileDirname}, \${fileBasename}, \${fileBasenameNoExtension}, \${relativeFile}?`;
	return new ProjectModelError(`vscwClang: unsupported variable '\${${name}}'. ${hint}`);
}

/** Substitutes `${...}` variables with guest paths. */
export function resolveVariables(text: string, ctx: VariableContext): string {
	return text.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
		const file = () => {
			if (ctx.file === undefined) {
				throw new ProjectModelError(`vscwClang: '\${${name}}' needs an active C/C++ file, but none is open in the editor. Did you mean to open the .cpp file you want to build first?`);
			}
			return ctx.file;
		};
		const slash = () => { const f = file(); return f.lastIndexOf('/'); };
		const base = () => file().slice(slash() + 1);
		switch (name) {
			case 'workspaceFolder': case 'cwd': return GUEST_WORKSPACE;
			case 'workspaceFolderBasename': return ctx.folderName;
			case 'pathSeparator': case '/': return '/';
			case 'file': return `${GUEST_WORKSPACE}/${file()}`;
			case 'relativeFile': return file();
			case 'fileDirname': return slash() < 0 ? GUEST_WORKSPACE : `${GUEST_WORKSPACE}/${file().slice(0, slash())}`;
			case 'relativeFileDirname': return slash() < 0 ? '.' : file().slice(0, slash());
			case 'fileBasename': return base();
			case 'fileBasenameNoExtension': return base().replace(/\.[^.]*$/, '');
			case 'fileExtname': return /\.[^.]*$/.exec(base())?.[0] ?? '';
			default: throw unknownVariable(name);
		}
	});
}

/**
 * Resolves `path` (relative to `cwd`, either slash style) to a normalized guest path.
 * Throws if it is a host path or leaves the workspace.
 */
export function toGuestPath(path: string, cwd: string): string {
	const slashed = path.replace(/\\/g, '/');
	if (/^[A-Za-z]:\//.test(slashed)) { throw outsideWorkspace(path); }
	const segments: string[] = [];
	for (const part of (slashed.startsWith('/') ? slashed : `${cwd}/${slashed}`).split('/')) {
		if (part === '' || part === '.') { continue; }
		if (part === '..') { segments.pop(); } else { segments.push(part); }
	}
	const guest = '/' + segments.join('/');
	if (guest !== GUEST_WORKSPACE && !guest.startsWith(`${GUEST_WORKSPACE}/`)) { throw outsideWorkspace(path); }
	return guest;
}

function outsideWorkspace(path: string): ProjectModelError {
	return new ProjectModelError(`vscwClang: '${path}' is outside the workspace folder, which is all a browser build can see. Did you mean a path under \${workspaceFolder}?`);
}

const toWorkspaceRelative = (guest: string) => guest === GUEST_WORKSPACE ? '.' : guest.slice(GUEST_WORKSPACE.length + 1);

/** Why `command` is not a clang-compatible compiler driver, or undefined if it is one. */
export function describeUnmappableCommand(command: string): string | undefined {
	let base = (command.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '');
	base = base.replace(/^.*-(?=(g\+\+|gcc|clang\+\+|clang|c\+\+|cc)(-[\d.]+)?$)/, '').replace(/-[\d.]+$/, '');
	if (COMPILERS.has(base)) { return undefined; }
	if (base === 'cl') { return `'${command}' is the MSVC compiler, whose /flags are not clang flags. Did you mean g++ or clang++ with -std=, -I and -D flags?`; }
	return `'${command}' is not a compiler driver this extension can map (g++, gcc, c++, cc, clang, clang++). A browser cannot run make, cmake or other programs; did you mean a task that calls g++/clang++ directly, or a build-system extension that writes compile_commands.json?`;
}

/** True if the task's command (the first word, for whole command lines) is a g++/clang++-style driver. */
export function isCompilerTask(task: TaskLike): boolean {
	if (typeof task.command !== 'string') { return false; }
	const first = /^"([^"]*)"|^\S+/.exec(task.command.trim());
	return first !== null && describeUnmappableCommand(first[1] ?? first[0]) === undefined;
}

function argText(arg: unknown): string {
	if (typeof arg === 'string') { return arg; }
	if (arg !== null && typeof arg === 'object' && typeof (arg as { value?: unknown }).value === 'string') { return (arg as { value: string }).value; }
	throw new ProjectModelError(`vscwClang: cannot read task argument ${JSON.stringify(arg)}. Did you mean a plain string?`);
}

interface ArgMapping {
	/** Maps the directory of `-I`/`-isystem`/`-iquote`/`-L`; undefined drops the flag with a note. */
	mapDir(dir: string): string | undefined;
	/** Workspace-relative source for a positional source file; undefined ignores it (databases name the file separately). */
	onSource(arg: string): string | undefined;
	/** Compilation databases: strip `-c` and dependency-file flags. */
	database?: boolean;
}

const DEPENDENCY_FLAGS = new Set(['-MD', '-MMD', '-MP', '-MG', '-M', '-MM']);
const DEPENDENCY_VALUE_FLAGS = new Set(['-MF', '-MT', '-MQ']);

/** Maps compiler arguments (without the compiler itself) onto flags, sources and the `-o` value; shared by tasks and databases. */
function mapArgs(args: readonly string[], label: string, m: ArgMapping): { sources: string[]; flags: string[]; notes: string[]; output?: string } {
	const sources: string[] = [];
	const flags: string[] = [];
	const notes: string[] = [];
	let output: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const pathFlag = PATH_FLAG.exec(a);
		if (a.startsWith('@')) {
			throw new ProjectModelError(`vscwClang: ${label}: response file '${a}' cannot be read. Did you mean to write its flags on the command line?`);
		}
		if (a === '-o') {
			if (args[i + 1] === undefined) { throw new ProjectModelError(`vscwClang: ${label}: '-o' has no file name. Did you mean '-o \${fileDirname}/\${fileBasenameNoExtension}'?`); }
			output = args[++i];
		} else if (m.database && (a === '-c' || DEPENDENCY_FLAGS.has(a))) {
			continue;
		} else if (m.database && DEPENDENCY_VALUE_FLAGS.has(a)) {
			i++;
		} else if (COLOR_FLAGS.test(a)) {
			notes.push(`dropped '${a}': diagnostics are parsed as plain text`);
		} else if (a in DROPPED_FLAGS) {
			notes.push(`dropped '${a}': ${DROPPED_FLAGS[a]}`);
		} else if (VALUE_FLAGS.has(a)) {
			if (args[i + 1] === undefined) { throw new ProjectModelError(`vscwClang: ${label}: '${a}' needs a value. Did you mean '${a}<value>'?`); }
			flags.push(a, args[++i]);
		} else if (pathFlag !== null) {
			const flag = pathFlag[1];
			const value = pathFlag[2] !== '' ? pathFlag[2] : args[++i];
			if (value === undefined) { throw new ProjectModelError(`vscwClang: ${label}: '${a}' needs a directory. Did you mean '${a}<dir>'?`); }
			const mapped = m.mapDir(value);
			if (mapped === undefined) { notes.push(`dropped '${flag}${value}': it is outside the workspace, which is all a browser build can see`); } else { flags.push(`${flag}${mapped}`); }
		} else if (a.startsWith('-')) {
			flags.push(a);
		} else if (SOURCE_EXTENSION.test(a)) {
			const source = m.onSource(a);
			if (source !== undefined) { sources.push(source); }
		} else if (/\.(h|hh|hpp|hxx)$/i.test(a)) {
			notes.push(`ignored header '${a}' on the command line`);
		} else {
			throw new ProjectModelError(`vscwClang: ${label}: cannot use '${a}' as an input. Did you mean a .c/.cpp source file? Object files and libraries cannot be linked in a browser build.`);
		}
	}
	return { sources, flags, notes, output };
}

/** Maps one `tasks.json` compile task (a g++/clang++ command line) onto a build plan. */
export function planFromTask(task: TaskLike, ctx: VariableContext): BuildPlan {
	const label = typeof task.label === 'string' ? task.label : String(task.command);
	if (typeof task.command !== 'string' || task.command === '') {
		throw new ProjectModelError(`vscwClang: task '${label}' has no command. Did you mean a command such as "g++" or "clang++"?`);
	}
	let command = task.command;
	let rawArgs = Array.isArray(task.args) ? task.args.map(argText) : [];
	if (rawArgs.length === 0 && /\s/.test(command)) {
		// A whole command line in "command" (shell tasks); keep backslashes of Windows paths, not of \" escapes.
		[command, ...rawArgs] = splitArgs(command.replace(/\\(?!["'\s])/g, '/'));
	}
	const unmappable = describeUnmappableCommand(resolveVariables(command, ctx));
	if (unmappable !== undefined) { throw new ProjectModelError(`vscwClang: task '${label}': ${unmappable}`); }
	const args = rawArgs.map(a => resolveVariables(a, ctx));
	const rawCwd = task.options?.cwd;
	const cwd = typeof rawCwd === 'string' ? toGuestPath(resolveVariables(rawCwd, ctx), GUEST_WORKSPACE) : GUEST_WORKSPACE;

	const absolutize = (dir: string) => { try { return toGuestPath(dir, cwd); } catch { return dir; } };
	const { sources, flags, notes, output } = mapArgs(args, `task '${label}'`, {
		mapDir: absolutize,
		onSource: a => toWorkspaceRelative(toGuestPath(a, cwd)).replace(/(^|\/)\*\*\./, '$1**/*.'),
	});
	if (sources.length === 0) {
		throw new ProjectModelError(`vscwClang: task '${label}' names no source file. Did you mean to pass \${file}, or a glob such as \${workspaceFolder}/*.cpp?`);
	}
	const problems = checkUserFlags(flags);
	if (problems.length > 0) { throw new ProjectModelError(`vscwClang: task '${label}': ${problems.join(' ')}`); }
	return {
		sources, flags, notes,
		outputName: output === undefined ? undefined : `${programStem(output)}.wasm`,
		mode: flags.includes('-g') ? 'debug' : 'release',
	};
}

export interface DatabasePlan extends BuildPlan {
	/** Workspace-relative source -> compile flags of its own entry. */
	perFileFlags: Record<string, string[]>;
	/** CMake targets found in the whole database (from `CMakeFiles/<target>.dir/` object paths), sorted; empty when it names none. */
	targets: string[];
}

function normalizeHostPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:)/, '').replace(/\/+$/, '');
}

const isAbsoluteHostPath = (p: string) => p.startsWith('/') || /^[A-Za-z]:/.test(p);

/**
 * Maps a path from a compilation database (made on any machine) to a guest path: relative paths start at `cwd`,
 * absolute ones must lie under `root` (the host path of the workspace folder). Undefined when outside the workspace.
 */
export function hostToGuest(path: string, cwd: string, root: string): string | undefined {
	const p = normalizeHostPath(path);
	const r = normalizeHostPath(root);
	try {
		if (!isAbsoluteHostPath(p)) { return toGuestPath(p, cwd); }
		const fold = /^[A-Za-z]:/.test(r);
		const [pc, rc] = fold ? [p.toLowerCase(), r.toLowerCase()] : [p, r];
		if (pc === rc || pc.startsWith(`${rc}/`)) { return toGuestPath(GUEST_WORKSPACE + p.slice(r.length), GUEST_WORKSPACE); }
		return p === GUEST_WORKSPACE || p.startsWith(`${GUEST_WORKSPACE}/`) ? toGuestPath(p, GUEST_WORKSPACE) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Finds the host path of the workspace folder a database was made against: the longest tail of an entry's source
 * path that `exists` (a workspace-relative path test) names the root as whatever precedes it.
 */
export function inferHostRoot(db: unknown, exists: (relative: string) => boolean): string | undefined {
	if (!Array.isArray(db)) { return undefined; }
	for (const entry of db as { directory?: unknown; file?: unknown }[]) {
		if (typeof entry?.file !== 'string') { continue; }
		const file = normalizeHostPath(entry.file);
		const full = isAbsoluteHostPath(file) || typeof entry.directory !== 'string' ? file : `${normalizeHostPath(entry.directory)}/${file}`;
		const parts = full.split('/');
		for (let i = 1; i < parts.length; i++) {
			if (exists(parts.slice(i).join('/'))) { return parts.slice(0, i).join('/') || '/'; }
		}
	}
	return undefined;
}

const CMAKE_TARGET = /(?:^|\/)CMakeFiles\/([^/]+)\.dir\//;

/**
 * Maps a `compile_commands.json` onto a build plan in which every entry's flags apply to its own file only.
 *
 * `root` is the host path of the workspace folder the file describes (see `inferHostRoot`). Like CMake Tools'
 * build target, `target` keeps only the entries whose object file lies in `CMakeFiles/<target>.dir/`; without it all
 * entries are kept. A second entry for a file already seen and non-C/C++ files are skipped with a note, as are paths
 * outside the workspace (include directories are dropped, sources are skipped).
 */
export function planFromCompileCommands(db: unknown, root: string, target?: string): DatabasePlan {
	if (!Array.isArray(db)) {
		throw new ProjectModelError('vscwClang: compile_commands.json must be a JSON array of {directory, file, command or arguments} objects. Did you mean to regenerate it (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON; Make: bear)?');
	}
	const notes: string[] = [];
	const perFileFlags: Record<string, string[]> = {};
	const targets = new Set<string>();
	for (const [i, raw] of db.entries()) {
		const e = raw as { directory?: unknown; file?: unknown; command?: unknown; arguments?: unknown; output?: unknown } | null;
		if (e === null || typeof e !== 'object' || typeof e.file !== 'string' || (typeof e.command !== 'string' && !Array.isArray(e.arguments))) {
			throw new ProjectModelError(`vscwClang: compile_commands.json entry ${i} needs a 'file' and a 'command' or 'arguments'. Did you mean to regenerate the file?`);
		}
		const label = `compile_commands.json entry '${e.file}'`;
		if (!SOURCE_EXTENSION.test(e.file)) { notes.push(`skipped '${e.file}': not a C/C++ source`); continue; }
		const cwd = typeof e.directory === 'string' ? hostToGuest(e.directory, GUEST_WORKSPACE, root) : GUEST_WORKSPACE;
		const guest = cwd === undefined ? undefined : hostToGuest(e.file, cwd, root);
		if (cwd === undefined || guest === undefined) { notes.push(`skipped '${e.file}': outside the workspace folder`); continue; }
		let tokens = Array.isArray(e.arguments) ? e.arguments.map(String) : splitArgs((e.command as string).replace(/\\(?!["'\s])/g, '/'));
		while (tokens.length > 0 && /^(ccache|sccache|distcc)$/i.test(programStem(tokens[0]))) { tokens = tokens.slice(1); }
		if (tokens.length === 0) { throw new ProjectModelError(`vscwClang: ${label} has an empty command. Did you mean to regenerate the file?`); }
		const unmappable = describeUnmappableCommand(tokens[0]);
		if (unmappable !== undefined) { throw new ProjectModelError(`vscwClang: ${label}: ${unmappable}`); }
		const mapped = mapArgs(tokens.slice(1), label, { mapDir: dir => hostToGuest(dir, cwd, root), onSource: () => undefined, database: true });
		const problems = checkUserFlags(mapped.flags);
		if (problems.length > 0) { throw new ProjectModelError(`vscwClang: ${label}: ${problems.join(' ')}`); }
		const found = CMAKE_TARGET.exec(normalizeHostPath(mapped.output ?? (typeof e.output === 'string' ? e.output : '')))?.[1];
		if (found !== undefined) { targets.add(found); }
		if (target !== undefined && found !== target) { continue; }
		const relative = toWorkspaceRelative(guest);
		if (relative in perFileFlags) { notes.push(`skipped a second entry for '${relative}' (the first is used)`); continue; }
		perFileFlags[relative] = mapped.flags;
		mapped.notes.forEach(n => notes.push(`${relative}: ${n}`));
	}
	const sources = Object.keys(perFileFlags);
	if (sources.length === 0) {
		throw new ProjectModelError(`vscwClang: compile_commands.json has no usable C/C++ entries${target === undefined ? '' : ` for target '${target}'`} inside the workspace folder. Did you mean to open the folder the file was generated for?`);
	}
	return { sources, flags: [], notes, perFileFlags, targets: [...targets].sort(), mode: sources.some(f => perFileFlags[f].includes('-g')) ? 'debug' : 'release' };
}

/** Maps `compile_flags.txt` (one flag per line, relative paths from the workspace folder) onto flags for every source. */
export function planFromCompileFlags(text: string): BuildPlan {
	const args = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
	const { flags, notes } = mapArgs(args, 'compile_flags.txt', { mapDir: dir => { try { return toGuestPath(dir, GUEST_WORKSPACE); } catch { return undefined; } }, onSource: () => undefined, database: true });
	const problems = checkUserFlags(flags);
	if (problems.length > 0) { throw new ProjectModelError(`vscwClang: compile_flags.txt: ${problems.join(' ')}`); }
	return { sources: [], flags, notes, mode: flags.includes('-g') ? 'debug' : 'release' };
}

function isBuildGroup(group: unknown): { build: boolean; isDefault: boolean } {
	if (group === 'build') { return { build: true, isDefault: false }; }
	if (group !== null && typeof group === 'object') {
		const g = group as { kind?: unknown; isDefault?: unknown };
		return { build: g.kind === 'build', isDefault: g.kind === 'build' && g.isDefault === true };
	}
	return { build: false, isDefault: false };
}

/** Entries for the tasks of `tasks.json` (the `tasks` array) that run a command, labelled as VS Code labels them. */
export function listTasks(tasks: unknown): TaskEntry[] {
	if (!Array.isArray(tasks)) { return []; }
	const entries: TaskEntry[] = [];
	for (const task of tasks as TaskLike[]) {
		if (task === null || typeof task !== 'object' || typeof task.command !== 'string') { continue; }
		entries.push({ label: typeof task.label === 'string' ? task.label : task.command, task, isDefaultBuild: isBuildGroup(task.group).isDefault });
	}
	return entries;
}

/** The task Build should use: the default build task, if `tasks.json` has one. */
export function defaultBuildTask(tasks: readonly TaskEntry[]): TaskEntry | undefined {
	return tasks.find(t => t.isDefaultBuild);
}

/** The `launch.json` configurations (the `configurations` array) that start a C/C++ program, with `args` resolved. */
export function listLaunches(configurations: unknown, ctx: VariableContext): LaunchEntry[] {
	if (!Array.isArray(configurations)) { return []; }
	const entries: LaunchEntry[] = [];
	for (const config of configurations as Record<string, unknown>[]) {
		if (config === null || typeof config !== 'object' || config.request !== 'launch' || !LAUNCH_TYPES.has(String(config.type))) { continue; }
		const name = typeof config.name === 'string' ? config.name : String(config.program);
		const rawArgs = typeof config.args === 'string' ? splitArgs(config.args) : Array.isArray(config.args) ? config.args.map(String) : undefined;
		let program: string | undefined;
		try { program = typeof config.program === 'string' ? resolveVariables(config.program, ctx) : undefined; } catch { program = undefined; }
		entries.push({
			name, program,
			args: rawArgs?.map(a => { try { return resolveVariables(a, ctx); } catch (e) { throw new ProjectModelError(`${(e as Error).message} (in launch configuration '${name}')`); } }),
			preLaunchTask: typeof config.preLaunchTask === 'string' ? config.preLaunchTask : undefined,
		});
	}
	return entries;
}

/**
 * The task that builds the program `launch` starts: its `preLaunchTask`, else a compile task whose `-o` names
 * `launch.program`, else the default build task. Undefined means fall back to the extension's own settings.
 */
export function taskForLaunch(tasks: readonly TaskEntry[], launch: LaunchEntry | undefined, ctx: VariableContext): TaskEntry | undefined {
	if (launch?.preLaunchTask !== undefined) {
		const named = tasks.find(t => t.label === launch.preLaunchTask);
		if (named !== undefined) { return named; }
	}
	if (launch?.program !== undefined) {
		const stem = programStem(launch.program);
		const match = tasks.find(t => {
			try { return isCompilerTask(t.task) && planFromTask(t.task, ctx).outputName === `${stem}.wasm`; } catch { return false; }
		});
		if (match !== undefined) { return match; }
	}
	return defaultBuildTask(tasks);
}
