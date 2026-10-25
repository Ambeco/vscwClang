import * as vscode from 'vscode';
import { LineEditor, toTerminalNewlines } from '../debug/lineEditor';

/** A running program's terminal: echoes and edits typed lines, hands each completed line to `onLine`, shows program output. */
export class ProgramTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly editor: LineEditor;
	private pending: string[] | undefined = [];

	constructor(private readonly onLine: (line: string) => void, private readonly hooks: { onInterrupt?: () => void; onClose?: () => void; onEof?: () => void } = {}) {
		this.editor = new LineEditor(hooks.onEof !== undefined);
	}

	/** VS Code drops writes made before `open`, so they wait for it. */
	open(): void {
		const early = this.pending ?? [];
		this.pending = undefined;
		early.forEach(text => this.writeEmitter.fire(text));
	}

	close(): void { this.hooks.onClose?.(); }

	handleInput(data: string): void {
		if (this.hooks.onInterrupt && data.includes('\u0003')) { this.hooks.onInterrupt(); return; }
		const { echo, lines, eof } = this.editor.feed(data);
		if (echo) { this.writeRaw(echo); }
		lines.forEach(this.onLine);
		if (eof) { this.hooks.onEof?.(); }
	}

	write(text: string): void { this.writeRaw(toTerminalNewlines(text)); }

	private writeRaw(text: string): void {
		if (this.pending) { this.pending.push(text); } else { this.writeEmitter.fire(text); }
	}
}
