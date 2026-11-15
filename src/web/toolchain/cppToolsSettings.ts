import { GUEST_WORKSPACE, stripWorkspaceFolder } from './guestPaths';

/** The subset of the C/C++ extension's `C_Cpp.default.*` settings that vscwClang can honor. */
export interface CppToolsDefaults {
	defines?: unknown;
	includePath?: unknown;
	forcedInclude?: unknown;
	compilerArgs?: unknown;
	cppStandard?: unknown;
	cStandard?: unknown;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/**
 * Compile flags equivalent to what the user's `C_Cpp.default.*` settings ask for, so a project configured for the
 * C/C++ extension on desktop builds and indexes the same here without re-entering them.
 *
 * Only `defines`, `includePath`, `forcedInclude` (as `-include`), `compilerArgs` and the two standards are mapped. `resolve` expands `${...}`
 * variables (`projectModel.resolveVariables`); entries it rejects are dropped with a note. Include paths must end up
 * inside the workspace (`${workspaceFolder}/x`, or relative to it); a trailing `/**` (recursive) is read as the
 * directory itself. The standards come back as `cFlags` and `cppFlags` (a `-std=` is an error for the other
 * language) for the caller to place before user flags. Anything unmappable is dropped and described in `notes`.
 */
export function cppToolsFlags(settings: CppToolsDefaults, resolve: (text: string) => string): { flags: string[]; cFlags: string[]; cppFlags: string[]; notes: string[] } {
	const flags: string[] = [];
	const cFlags: string[] = [];
	const cppFlags: string[] = [];
	const notes: string[] = [];
	const seen = new Set<string>();
	const expand = (name: string, raw: string): string | undefined => {
		try { return resolve(raw); } catch (e) {
			notes.push(`${name} entry '${raw}' was skipped: ${(e as Error).message.replace(/^vscwClang: /, '')}`);
			return undefined;
		}
	};
	const workspacePath = (name: string, raw: string, recursiveOk: boolean): string | undefined => {
		const recursive = /[\\/]\*\*$/.test(raw);
		const resolved = expand(name, raw.trim().replace(/[\\/]\*\*$/, ''));
		if (resolved === undefined) { return undefined; }
		const trimmed = resolved.replace(/\\/g, '/');
		let guest: string | undefined;
		if (trimmed === GUEST_WORKSPACE || trimmed.startsWith(`${GUEST_WORKSPACE}/`)) { guest = trimmed; }
		else if (!/^([a-zA-Z]:|\/|\$|~)/.test(trimmed)) { guest = `${GUEST_WORKSPACE}/${trimmed}`; }
		if (guest === undefined) {
			notes.push(`${name} entry '${raw}' is outside the workspace, so it was skipped. Did you mean a path relative to the workspace folder, such as \${workspaceFolder}/${recursiveOk ? 'include' : 'config.h'}?`);
			return undefined;
		}
		guest = guest.replace(/\/\.(?=\/|$)/g, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/') || GUEST_WORKSPACE;
		if (recursive && recursiveOk) { notes.push(`${name} entry '${raw}' is recursive; only '${guest}' itself was added. List subfolders separately if needed.`); }
		return guest;
	};
	for (const raw of strings(settings.includePath)) {
		if (raw.trim() === '${default}') { continue; }
		const guest = workspacePath('C_Cpp.default.includePath', raw, true);
		if (guest === undefined) { continue; }
		const flag = `-I${guest}`;
		if (!seen.has(flag)) { seen.add(flag); flags.push(flag); }
	}
	for (const raw of strings(settings.forcedInclude)) {
		if (raw.trim() === '${default}') { continue; }
		const guest = workspacePath('C_Cpp.default.forcedInclude', raw, false);
		if (guest !== undefined) { flags.push('-include', guest); }
	}
	for (const define of strings(settings.defines)) {
		const resolved = expand('C_Cpp.default.defines', define.trim());
		if (resolved !== undefined) { flags.push(`-D${resolved}`); }
	}
	const standards: [unknown, string, RegExp, string, string[]][] = [
		[settings.cppStandard, 'C_Cpp.default.cppStandard', /^(c|gnu)\+\+\d\d$/, 'c++20 or gnu++17', cppFlags],
		[settings.cStandard, 'C_Cpp.default.cStandard', /^(c|gnu)\d\d$/, 'c11 or gnu17', cFlags],
	];
	for (const [value, name, valid, example, into] of standards) {
		const standard = typeof value === 'string' ? value.trim() : '';
		if (valid.test(standard)) { into.push(`-std=${standard}`); }
		else if (standard !== '' && standard !== '${default}') { notes.push(`${name} '${standard}' is not a -std= value clang accepts (such as ${example}), so it was skipped.`); }
	}
	for (const arg of strings(settings.compilerArgs)) {
		const resolved = expand('C_Cpp.default.compilerArgs', arg.trim());
		if (resolved !== undefined) { flags.push(resolved); }
	}
	return { flags, cFlags, cppFlags, notes };
}

/**
 * First usable path from a `compileCommands` setting, which (like `C_Cpp.default.compileCommands`) may be a string
 * or an array of strings. A leading `${workspaceFolder}/` is dropped (`stripWorkspaceFolder`).
 */
export function compileCommandsPath(value: unknown): string | undefined {
	const candidates = typeof value === 'string' ? [value] : strings(value);
	for (const candidate of candidates) {
		const path = stripWorkspaceFolder(candidate.trim().replace(/\\/g, '/'));
		if (path !== '') { return path; }
	}
	return undefined;
}

export type LoggingLevel = 'None' | 'Error' | 'Warning' | 'Information' | 'Debug';

/** clangd's `-log=` level for a (cpptools-style) logging level; clangd has no quieter level than `error`. */
export function clangdLogLevel(level: string): 'error' | 'info' | 'verbose' {
	return level === 'Debug' ? 'verbose' : level === 'Information' ? 'info' : 'error';
}

/** Whether to echo clangd's stderr into the output channel (otherwise it is only shown when clangd dies). */
export function logsClangdStderr(level: string): boolean {
	return level === 'Warning' || level === 'Information' || level === 'Debug';
}

/**
 * The effective `files.exclude` object: ours and `C_Cpp.files.exclude` merged, with the one the user actually set
 * winning on a conflict (cpptools' value beats our default, ours beats cpptools' when both are set).
 */
export function mergeExclude(own: Readonly<Record<string, unknown>>, ownIsUserSet: boolean, cpptools: unknown): Record<string, unknown> {
	const theirs = typeof cpptools === 'object' && cpptools !== null && !Array.isArray(cpptools) ? cpptools as Record<string, unknown> : {};
	return ownIsUserSet ? { ...theirs, ...own } : { ...own, ...theirs };
}
