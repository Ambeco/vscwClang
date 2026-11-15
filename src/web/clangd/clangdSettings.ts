/** The `C_Cpp.*` values clangd can honor; each is `undefined` when unset. */
export interface CppToolsClangdSettings {
	includeHeader?: unknown;
	clangTidyEnabled?: unknown;
	tidyChecksEnabled?: unknown;
	tidyChecksDisabled?: unknown;
	tidyHeaderFilter?: unknown;
	tidyConfig?: unknown;
	tidyFallbackConfig?: unknown;
	tidyArgs?: unknown;
	inlayParameterNames?: unknown;
	inlayAutoTypes?: unknown;
	formatting?: unknown;
	formatStyle?: unknown;
	formatFallbackStyle?: unknown;
	formatSortIncludes?: unknown;
	formatPath?: unknown;
	/** Other `C_Cpp.inlayHints.*` values, by setting name (without the prefix), that clangd cannot honor. */
	inlayUnsupported?: Readonly<Record<string, unknown>>;
}

/** `C_Cpp.inlayHints.*` keys (after the prefix) with no clangd equivalent; the client reads each so it can say so. */
export const INLAY_UNSUPPORTED = ['autoDeclarationTypes.showOnLeft', 'parameterNames.hideLeadingUnderscores', 'parameterNames.suppressWhenArgumentContainsName', 'referenceOperator.enabled', 'referenceOperator.showSpace'];

export interface ClangdSettingsMapping {
	/** Extra clangd command-line arguments. */
	args: string[];
	tidyAdd: string[];
	tidyRemove: string[];
	inlayHints: InlayHintsConfig;
	/** False when `C_Cpp.formatting` is `disabled`: the client then answers every format request with no edits. */
	formattingEnabled: boolean;
	notes: string[];
}

/** Which clangd inlay hint kinds to force on or off; undefined leaves clangd's default (on). */
export interface InlayHintsConfig {
	parameterNames?: boolean;
	deducedTypes?: boolean;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : [];
}

const hasText = (value: unknown): boolean => (typeof value === 'string' && value.trim() !== '') || (Array.isArray(value) && value.length > 0);

/**
 * clangd arguments and clang-tidy checks equivalent to cpptools' `C_Cpp.refactoring.includeHeader` and
 * `C_Cpp.codeAnalysis.clangTidy.*` settings.
 *
 * `includeHeader: never` becomes `-header-insertion=never` (the others are clangd's default `iwyu`). The tidy
 * `enabled: false` becomes `-clang-tidy=false`; the enabled and disabled check lists become the user config's
 * `ClangTidy: Add/Remove`. `headerFilter`, `config`, `fallbackConfig` and `args` have no clangd equivalent (clangd
 * reads `.clang-tidy` files itself), so they are reported in `notes`.
 *
 * `C_Cpp.inlayHints.parameterNames.enabled` and `autoDeclarationTypes.enabled` become the config's
 * `InlayHints: ParameterNames/DeducedTypes`. cpptools defaults both to off while clangd defaults to on, so they only
 * change anything when set explicitly. The other inlayHints keys have no clangd option and are noted when set.
 *
 * Formatting is clangd's built-in clang-format. `clang_format_fallbackStyle` becomes `-fallback-style=` (used when no
 * `.clang-format` exists; cpptools' "Visual Studio" is clang-format's `Microsoft`); `formatting: disabled` clears
 * `formattingEnabled`. `clang_format_style` other than `file`, `sortIncludes`, `clang_format_path` and
 * `formatting: vcFormat` have no clangd equivalent and are reported in `notes`.
 */
export function mapClangdSettings(settings: CppToolsClangdSettings): ClangdSettingsMapping {
	const args: string[] = [];
	const notes: string[] = [];
	if (settings.includeHeader === 'never') { args.push('-header-insertion=never'); }
	else if (settings.includeHeader !== undefined && settings.includeHeader !== null && settings.includeHeader !== 'ifNeeded' && settings.includeHeader !== 'always') {
		notes.push(`C_Cpp.refactoring.includeHeader '${String(settings.includeHeader)}' is not one of always, ifNeeded or never, so clangd's default (insert when needed) is used.`);
	}
	if (settings.clangTidyEnabled === false) { args.push('-clang-tidy=false'); }
	const tidyOff = settings.clangTidyEnabled === false;
	const tidyAdd = tidyOff ? [] : strings(settings.tidyChecksEnabled);
	const tidyRemove = tidyOff ? [] : strings(settings.tidyChecksDisabled);
	if (tidyOff && (tidyAdd.length > 0 || hasText(settings.tidyChecksEnabled))) { notes.push('C_Cpp.codeAnalysis.clangTidy.checks.enabled is ignored because clangTidy.enabled is false.'); }
	const unsupported: [string, unknown][] = [
		['headerFilter', settings.tidyHeaderFilter], ['config', settings.tidyConfig], ['fallbackConfig', settings.tidyFallbackConfig], ['args', settings.tidyArgs],
	];
	for (const [name, value] of unsupported) {
		if (hasText(value)) { notes.push(`C_Cpp.codeAnalysis.clangTidy.${name} is not supported: clangd reads clang-tidy options only from .clang-tidy files. Did you mean to put it in a .clang-tidy file in the workspace?`); }
	}
	const inlayHints: InlayHintsConfig = {};
	for (const [name, value, key] of [['parameterNames.enabled', settings.inlayParameterNames, 'parameterNames'], ['autoDeclarationTypes.enabled', settings.inlayAutoTypes, 'deducedTypes']] as const) {
		if (typeof value === 'boolean') { inlayHints[key] = value; }
		else if (value !== undefined && value !== null) { notes.push(`C_Cpp.inlayHints.${name} '${String(value)}' is not true or false, so clangd's default is used.`); }
	}
	for (const [name, value] of Object.entries(settings.inlayUnsupported ?? {})) {
		if (value !== undefined && value !== null) { notes.push(`C_Cpp.inlayHints.${name} is not supported: clangd has no option for it. Did you mean editor.inlayHints.enabled to show or hide all hints?`); }
	}
	const formattingEnabled = settings.formatting !== 'disabled';
	if (settings.formatting === 'vcFormat') { notes.push("C_Cpp.formatting 'vcFormat' is not supported: clang-format is used instead. Did you mean to set 'disabled' to turn formatting off?"); }
	if (formattingEnabled) {
		const fallback = typeof settings.formatFallbackStyle === 'string' ? settings.formatFallbackStyle.trim() : '';
		if (fallback !== '') { args.push(`-fallback-style=${fallback.toLowerCase() === 'visual studio' ? 'Microsoft' : fallback}`); }
		const style = typeof settings.formatStyle === 'string' ? settings.formatStyle.trim() : '';
		if (style !== '' && style !== 'file') { notes.push(`C_Cpp.clang_format_style '${style}' is not supported: clangd always uses the nearest .clang-format file. Did you mean to put 'BasedOnStyle: ${style}' in a .clang-format file in your workspace?`); }
		if (typeof settings.formatSortIncludes === 'boolean') { notes.push('C_Cpp.clang_format_sortIncludes is not supported: clangd takes it from the .clang-format file. Did you mean to set SortIncludes: ' + (settings.formatSortIncludes ? 'CaseSensitive' : 'Never') + ' there?'); }
		if (hasText(settings.formatPath)) { notes.push('C_Cpp.clang_format_path is ignored: the clang-format built into clangd is always used, since no other program can run in a browser.'); }
	}
	return { args, tidyAdd, tidyRemove, inlayHints, formattingEnabled, notes };
}

/** C++ source and header extensions clangd already treats as C++ (`.h` is the ambiguous one). */
const CPP_EXTENSIONS = ['cc', 'cpp', 'cxx', 'C', 'hh', 'hpp', 'hxx'];

/**
 * Whether a plain `.h` should be analyzed as C++: unless the workspace has C sources and no C++ ones, as cpptools'
 * default association does. Without this clangd reads every `.h` as C, so `class` and `<vector>` are errors.
 */
export function headersAreCpp(sourcePaths: readonly string[]): boolean {
	const lower = sourcePaths.map(p => p.toLowerCase());
	const hasC = lower.some(p => p.endsWith('.c'));
	const hasCpp = lower.some(p => /\.(cc|cpp|cxx)$/.test(p));
	return hasCpp || !hasC;
}

export interface ClangdUserConfigInput {
	headersAsCpp: boolean;
	/** `-std=` for C++ and C files; omit for files that already have a command from a database or the user's flags. */
	cppStd?: string;
	cStd?: string;
	tidyAdd: readonly string[];
	tidyRemove: readonly string[];
	inlayHints?: InlayHintsConfig;
}

// Single-quoted scalars have no escapes, which clangd's YAML reader mishandles for `\` in double quotes.
const yamlString = (text: string): string => `'${text.replace(/'/g, "''")}'`;
const yamlList = (items: readonly string[]): string => `[${items.map(yamlString).join(', ')}]`;

/**
 * The text of clangd's user `config.yaml` (read from `$XDG_CONFIG_HOME/clangd/`): file-type specific flags for files
 * with no compile command, which clangd's single `fallbackFlags` list cannot express, plus clang-tidy checks.
 *
 * `.h` becomes `-xc++-header` when `headersAsCpp`. Each language's standard is added only to its own files.
 */
export function clangdUserConfig(input: ClangdUserConfigInput): string {
	const fragments: string[] = [];
	const fragment = (pathMatch: string, flags: string[]) => {
		if (flags.length > 0) { fragments.push(`If:\n  PathMatch: ${yamlString(pathMatch)}\nCompileFlags:\n  Add: ${yamlList(flags)}`); }
	};
	if (input.headersAsCpp) { fragment('.*\\.h', ['-xc++-header']); }
	const cppExts = [...CPP_EXTENSIONS, ...(input.headersAsCpp ? ['h'] : [])].join('|');
	if (input.cppStd) { fragment(`.*\\.(${cppExts})`, [input.cppStd]); }
	if (input.cStd) { fragment(`.*\\.(c${input.headersAsCpp ? '' : '|h'})`, [input.cStd]); }
	if (input.tidyAdd.length > 0 || input.tidyRemove.length > 0) {
		const lines = ['Diagnostics:', '  ClangTidy:'];
		if (input.tidyAdd.length > 0) { lines.push(`    Add: ${yamlList(input.tidyAdd)}`); }
		if (input.tidyRemove.length > 0) { lines.push(`    Remove: ${yamlList(input.tidyRemove)}`); }
		fragments.push(lines.join('\n'));
	}
	const hints = input.inlayHints;
	if (hints && (hints.parameterNames !== undefined || hints.deducedTypes !== undefined)) {
		const yesNo = (v: boolean) => v ? 'Yes' : 'No';
		const lines = ['InlayHints:'];
		if (hints.parameterNames !== undefined) { lines.push(`  ParameterNames: ${yesNo(hints.parameterNames)}`); }
		if (hints.deducedTypes !== undefined) { lines.push(`  DeducedTypes: ${yesNo(hints.deducedTypes)}`); }
		fragments.push(lines.join('\n'));
	}
	return `# Generated by vscwClang from its settings; edits are overwritten.\n${fragments.map(f => f + '\n').join('---\n')}`;
}
