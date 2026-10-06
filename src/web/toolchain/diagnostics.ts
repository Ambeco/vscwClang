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
const BARE_LINE = /^(?:(?:clang\+\+|clang|wasm-ld|ld\.lld|lld): )?(fatal error|error|warning|note): (.*)$/;
const LLD_DETAIL = /^>>>\s?(.*)$/;
const FLAG_SUFFIX = /\s+\[(-W[^\]]+)\]$/;

/**
 * Parses clang/wasm-ld text output (built with `-fno-color-diagnostics -fno-caret-diagnostics`).
 *
 * `note:` lines attach to the preceding non-note diagnostic, as do wasm-ld `>>>` detail lines.
 * "In file included from" lines and trailing summaries ("2 errors generated.") are dropped.
 * Location-less lines (driver errors such as `clang++: error: unknown argument`, linker errors) have no `file`.
 * Unrecognised lines are ignored, so callers should still show the raw text.
 */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
	const result: ParsedDiagnostic[] = [];
	let current: ParsedDiagnostic | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const clang = CLANG_LINE.exec(line);
		const bare = clang ? null : BARE_LINE.exec(line);
		const detail = clang || bare ? null : LLD_DETAIL.exec(line);
		let diag: ParsedDiagnostic;
		if (clang) {
			const [, file, ln, col, sev, msg] = clang;
			diag = { file, line: Number(ln), column: col ? Number(col) : undefined, severity: sev === 'fatal error' ? 'error' : sev as Severity, ...splitFlag(msg), notes: [] };
		} else if (bare) {
			diag = { severity: bare[1] === 'fatal error' ? 'error' : bare[1] as Severity, ...splitFlag(bare[2]), notes: [] };
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

/**
 * Returns `parsed`, plus a synthesized error built from the tail of `rawText` when a tool failed
 * (`exitCode !== 0`) without any parsed error, so a failed build never leaves Problems empty.
 */
export function withFailureFallback(parsed: ParsedDiagnostic[], exitCode: number, rawText: string): ParsedDiagnostic[] {
	if (exitCode === 0 || parsed.some(d => d.severity === 'error')) { return parsed; }
	const tail = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l).slice(-5).join(' | ');
	const message = tail ? `Build failed (exit ${exitCode}); last output: ${tail}` : `Build failed (exit ${exitCode}) with no output; see the vscwclang output channel.`;
	return [...parsed, { severity: 'error', message, notes: [] }];
}
