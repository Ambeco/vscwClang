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

	const sources: string[] = [];
	const flags: string[] = [];
	const notes: string[] = [];
	let output: string | undefined;
	const absolutize = (dir: string) => { try { return toGuestPath(dir, cwd); } catch { return dir; } };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const pathFlag = PATH_FLAG.exec(a);
		if (a === '-o') {
			if (args[i + 1] === undefined) { throw new ProjectModelError(`vscwClang: task '${label}': '-o' has no file name. Did you mean '-o \${fileDirname}/\${fileBasenameNoExtension}'?`); }
			output = args[++i];
		} else if (COLOR_FLAGS.test(a)) {
			notes.push(`dropped '${a}': diagnostics are parsed as plain text`);
		} else if (a in DROPPED_FLAGS) {
			notes.push(`dropped '${a}': ${DROPPED_FLAGS[a]}`);
		} else if (VALUE_FLAGS.has(a)) {
			if (args[i + 1] === undefined) { throw new ProjectModelError(`vscwClang: task '${label}': '${a}' needs a value. Did you mean '${a}<value>'?`); }
			flags.push(a, args[++i]);
		} else if (pathFlag !== null) {
			const flag = pathFlag[1];
			const value = pathFlag[2] !== '' ? pathFlag[2] : args[++i];
			if (value === undefined) { throw new ProjectModelError(`vscwClang: task '${label}': '${a}' needs a directory. Did you mean '${a}<dir>'?`); }
			flags.push(`${flag}${absolutize(value)}`);
		} else if (a.startsWith('-')) {
			flags.push(a);
		} else if (SOURCE_EXTENSION.test(a)) {
			sources.push(toWorkspaceRelative(toGuestPath(a, cwd)).replace(/(^|\/)\*\*\./, '$1**/*.'));
		} else if (/\.(h|hh|hpp|hxx)$/i.test(a)) {
			notes.push(`ignored header '${a}' on the command line`);
		} else {
			throw new ProjectModelError(`vscwClang: task '${label}': cannot use '${a}' as an input. Did you mean a .c/.cpp source file? Object files and libraries cannot be linked in a browser build.`);
		}
	}
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
