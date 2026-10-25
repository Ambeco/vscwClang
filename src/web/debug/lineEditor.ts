/**
 * Minimal line editor for a pseudoterminal that feeds a program's stdin; vscode-free.
 *
 * `feed` takes what the terminal's `handleInput` received and returns the text to echo plus the lines completed
 * by Enter (each ending in a newline). Backspace edits the pending line; Ctrl+C, arrow keys and other escape
 * sequences are ignored, because the program's terminal has no signals. Ctrl+D is ignored too unless `eofKey` is set:
 * then, as in a Unix tty, it hands over the pending line without a newline, or on an empty line sets `eof`
 * (input after it is dropped).
 */
export class LineEditor {
	private line = '';
	private escape: 'start' | 'body' | undefined;

	constructor(private readonly eofKey = false) {}

	feed(data: string): { echo: string; lines: string[]; eof?: true } {
		let echo = '';
		const lines: string[] = [];
		for (const ch of data) {
			if (this.escape === 'start') {
				// ESC [ and ESC O (arrow keys, Home, F-keys) continue to a final letter or '~'; any other second byte is the whole sequence.
				this.escape = ch === '[' || ch === 'O' ? 'body' : undefined;
				continue;
			}
			if (this.escape === 'body') {
				if (/[A-Za-z~]/.test(ch)) { this.escape = undefined; }
				continue;
			}
			if (ch === '\x1b') { this.escape = 'start'; continue; }
			if (ch === '\x04' && this.eofKey) {
				if (this.line === '') { return { echo, lines, eof: true }; }
				lines.push(this.line);
				this.line = '';
				continue;
			}
			if (ch === '\r' || ch === '\n') {
				echo += '\r\n';
				lines.push(this.line + '\n');
				this.line = '';
			} else if (ch === '\x7f' || ch === '\b') {
				if (this.line.length > 0) {
					const last = [...this.line].pop()!;
					this.line = this.line.slice(0, this.line.length - last.length);
					echo += '\b \b';
				}
			} else if (ch >= ' ') {
				this.line += ch;
				echo += ch;
			}
		}
		return { echo, lines };
	}
}

/** Terminal text uses CR LF; program output uses bare LF. */
export function toTerminalNewlines(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}
