/** vscode.DiagnosticSeverity values, spelled out so this file needs no vscode import. */
const WARNING = 1;
const HINT = 3;

/**
 * Raises clang-tidy diagnostics that clangd reports as Hints to Warnings.
 *
 * VS Code lists a Hint only as faint dots in the editor, never in Problems, so tidy findings such as
 * `modernize-use-nullptr` would be invisible there; cpptools and the clangd extension show them as warnings.
 * Returns the same array when nothing changes.
 *
 * @helper
 */
export function raiseTidyHints<T extends { source?: string; severity?: number }>(diagnostics: readonly T[]): readonly T[] {
	if (!diagnostics.some(isTidyHint)) { return diagnostics; }
	return diagnostics.map(d => isTidyHint(d) ? Object.assign(Object.create(Object.getPrototypeOf(d) as object) as T, d, { severity: WARNING }) : d);
}

function isTidyHint(d: { source?: string; severity?: number }): boolean {
	return d.source === 'clang-tidy' && d.severity === HINT;
}
