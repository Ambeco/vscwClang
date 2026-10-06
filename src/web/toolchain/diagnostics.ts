export type Severity = 'error' | 'warning' | 'note' | 'remark';

export interface ParsedDiagnostic {
	/** Path exactly as clang printed it (a guest path such as /workspace/a.cpp); absent for linker-wide errors. */
	file?: string;
	/** 1-based. */
	line?: number;
	/** 1-based. */
	column?: number;
	severity: Severity;
	message: string;
	/** The `-W...` option from a trailing `[-Wfoo]`. */
	flag?: string;
	/** Following `note:` lines, plus wasm-ld `>>>` detail lines. */
	notes: ParsedDiagnostic[];
}

const CLANG_LINE = /^(.+?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note|remark):\s+(.*)$/;
const LLD_LINE = /^(?:wasm-ld|ld\.lld|lld): (error|warning|note): (.*)$/;
const LLD_DETAIL = /^>>>\s?(.*)$/;
const FLAG_SUFFIX = /\s+\[(-W[^\]]+)\]$/;

/**
 * Parses clang/wasm-ld text output (built with `-fno-color-diagnostics -fno-caret-diagnostics`).
 *
 * `note:` lines attach to the preceding non-note diagnostic, as do wasm-ld `>>>` detail lines.
 * "In file included from" lines and trailing summaries ("2 errors generated.") are dropped.
 * Unrecognised lines are ignored, so callers should still show the raw text.
 */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
	const result: ParsedDiagnostic[] = [];
	let current: ParsedDiagnostic | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const clang = CLANG_LINE.exec(line);
		const lld = clang ? null : LLD_LINE.exec(line);
		const detail = clang || lld ? null : LLD_DETAIL.exec(line);
		let diag: ParsedDiagnostic;
		if (clang) {
			const [, file, ln, col, sev, msg] = clang;
			diag = { file, line: Number(ln), column: col ? Number(col) : undefined, severity: sev === 'fatal error' ? 'error' : sev as Severity, ...splitFlag(msg), notes: [] };
		} else if (lld) {
			diag = { severity: lld[1] as Severity, ...splitFlag(lld[2]), notes: [] };
		} else if (detail) {
			current?.notes.push({ severity: 'note', message: detail[1], notes: [] });
			continue;
		} else {
			continue;
		}
		if (diag.severity === 'note' && current) {
			current.notes.push(diag);
		} else {
			result.push(diag);
			current = diag;
		}
	}
	return result;
}

function splitFlag(message: string): { message: string; flag?: string } {
	const m = FLAG_SUFFIX.exec(message);
	return m ? { message: message.slice(0, m.index), flag: m[1] } : { message };
}
