import type { CppToolsDefaults } from './cppToolsSettings';

/** Removes `//` and block comments and trailing commas outside strings, so `JSON.parse` accepts VS Code's JSONC. */
export function stripJsonc(text: string): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') { j += text[j] === '\\' ? 2 : 1; }
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') { i++; }
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out.replace(/,(\s*[\]}])/g, '$1');
}

/** What `.vscode/c_cpp_properties.json` contributes: the `C_Cpp.default.*` shapes plus the two keys only it has. */
export interface CppProperties extends CppToolsDefaults {
	compileCommands?: unknown;
	/** Name of the configuration that was used. */
	configName?: string;
	notes: string[];
}

/**
 * Reads the first configuration of a `c_cpp_properties.json` text (cpptools picks one in the status bar; there is no
 * such picker here, so the first is used and its name reported).
 *
 * Only `defines`, `includePath`, `forcedInclude`, `compilerArgs`, `cStandard`, `cppStandard` and `compileCommands`
 * are read. `compilerPath`, `intelliSenseMode`, `browse` and the like have no meaning for one wasm32 target and are
 * ignored silently; `configurationProvider` and a malformed file are described in `notes`.
 */
export function parseCppProperties(text: string): CppProperties {
	const notes: string[] = [];
	let parsed: unknown;
	try { parsed = JSON.parse(stripJsonc(text.replace(/^﻿/, ''))); } catch (e) {
		return { notes: [`.vscode/c_cpp_properties.json is not valid JSON (${(e as Error).message}), so it was ignored. Did you mean to fix the syntax near that position?`] };
	}
	const configs = (parsed as { configurations?: unknown } | null)?.configurations;
	if (!Array.isArray(configs) || configs.length === 0 || typeof configs[0] !== 'object' || configs[0] === null) {
		return { notes: ['.vscode/c_cpp_properties.json has no "configurations" entry, so it was ignored. Did you mean to add one, as cpptools writes it?'] };
	}
	const config = configs[0] as Record<string, unknown>;
	if (typeof config.configurationProvider === 'string' && config.configurationProvider !== '') {
		notes.push(`c_cpp_properties.json configurationProvider '${config.configurationProvider}' is not supported (flags come from the file's own entries, compile_commands.json or the C_Cpp.default.* settings).`);
	}
	return {
		defines: config.defines, includePath: config.includePath, forcedInclude: config.forcedInclude, compilerArgs: config.compilerArgs,
		cppStandard: config.cppStandard, cStandard: config.cStandard, compileCommands: config.compileCommands,
		configName: typeof config.name === 'string' ? config.name : undefined, notes,
	};
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/**
 * `C_Cpp.default.*` settings with `c_cpp_properties.json` laid over them: like cpptools, the project file wins for
 * every key it sets, and the settings fill the rest.
 */
export function overlayProperties(settings: CppToolsDefaults, properties: CppProperties | undefined): CppToolsDefaults {
	if (!properties) { return settings; }
	const pick = (key: keyof CppToolsDefaults) => present(properties[key]) ? properties[key] : settings[key];
	return { defines: pick('defines'), includePath: pick('includePath'), forcedInclude: pick('forcedInclude'), compilerArgs: pick('compilerArgs'), cppStandard: pick('cppStandard'), cStandard: pick('cStandard') };
}
