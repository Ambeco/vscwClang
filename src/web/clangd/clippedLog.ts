/**
 * Batches log text and cuts over-long lines, before it reaches an output channel.
 *
 * clangd at `Debug` logs every LSP message whole, so opening a 1.8 MB file is one 1.8 MB line, and it arrives a few
 * bytes at a time. Appending that straight to a VS Code output channel froze the page for minutes. `append` holds
 * text for `delayMs` and then writes it in one call; a line is cut after `maxLine` characters and ends with how many
 * were left out (the cut can span appends). `flush` writes at once.
 *
 * @helper
 */
export class ClippedLog {
	private pending: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private column = 0;
	private dropped = 0;

	constructor(private readonly write: (text: string) => void, private readonly maxLine = 4000, private readonly delayMs = 100) {}

	append(text: string): void {
		this.pending.push(text);
		this.timer ??= setTimeout(() => this.flush(), this.delayMs);
	}

	flush(): void {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		if (this.pending.length === 0) { return; }
		const pieces = this.pending.join('').split('\n');
		this.pending = [];
		let out = '';
		pieces.forEach((piece, i) => {
			const room = Math.max(0, this.maxLine - this.column);
			out += piece.slice(0, room);
			this.column += Math.min(piece.length, room);
			this.dropped += Math.max(0, piece.length - room);
			if (i < pieces.length - 1) {
				if (this.dropped > 0) { out += ` ... [${this.dropped} more characters not shown]`; }
				out += '\n';
				this.column = 0;
				this.dropped = 0;
			}
		});
		if (out) { this.write(out); }
	}
}
