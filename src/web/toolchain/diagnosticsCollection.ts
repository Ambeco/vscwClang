import * as vscode from 'vscode';
import { fromGuestPath } from './guestPaths';
import { workspaceAnchor, type ParsedDiagnostic } from './diagnostics';

const SEVERITY: Record<ParsedDiagnostic['severity'], vscode.DiagnosticSeverity> = {
	error: vscode.DiagnosticSeverity.Error,
	warning: vscode.DiagnosticSeverity.Warning,
	note: vscode.DiagnosticSeverity.Information,
	remark: vscode.DiagnosticSeverity.Hint,
};

/**
 * Replaces the collection's contents with `parsed`, mapping guest paths back under `folder`.
 *
 * Diagnostics without a file (linker errors) or outside the workspace (sysroot headers) are attached to
 * `fallback`, with the original path prefixed to the message so nothing is silently dropped.
 */
export function publishDiagnostics(collection: vscode.DiagnosticCollection, folder: vscode.Uri, parsed: readonly ParsedDiagnostic[], fallback: vscode.Uri): void {
	const byFile = new Map<string, { uri: vscode.Uri; diags: vscode.Diagnostic[] }>();
	const resolve = (file: string | undefined) => {
		const path = file === undefined ? undefined : fromGuestPath(folder.path, file);
		return path === undefined ? undefined : folder.with({ path });
	};
	for (const p of parsed) {
		const anchor = workspaceAnchor(p, f => resolve(f) !== undefined);
		const uri = resolve(anchor?.file) ?? fallback;
		const where = p.file !== undefined && anchor !== p ? `${p.file}:${p.line ?? 1}: ` : '';
		const line = anchor ? Math.max((anchor.line ?? 1) - 1, 0) : 0;
		const column = anchor ? Math.max((anchor.column ?? 1) - 1, 0) : 0;
		const diag = new vscode.Diagnostic(new vscode.Range(line, column, line, column), where + p.message, SEVERITY[p.severity]);
		diag.source = 'clang';
		if (p.flag) { diag.code = p.flag; }
		diag.relatedInformation = p.notes.map(n => {
			const noteUri = resolve(n.file) ?? uri;
			const nl = resolve(n.file) ? Math.max((n.line ?? 1) - 1, 0) : line;
			const nc = resolve(n.file) ? Math.max((n.column ?? 1) - 1, 0) : column;
			return new vscode.DiagnosticRelatedInformation(new vscode.Location(noteUri, new vscode.Position(nl, nc)), n.message);
		});
		const entry = byFile.get(uri.toString()) ?? { uri, diags: [] };
		entry.diags.push(diag);
		byFile.set(uri.toString(), entry);
	}
	collection.clear();
	collection.set([...byFile.values()].map(e => [e.uri, e.diags] as [vscode.Uri, vscode.Diagnostic[]]));
}
