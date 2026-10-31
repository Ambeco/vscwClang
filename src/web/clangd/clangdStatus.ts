/** What the status bar shows for a clangd file state, or undefined when nothing should show (`idle`). */
export function statusLabel(state: string | undefined): string | undefined {
	if (state === undefined || state === 'idle') { return undefined; }
	return `$(sync~spin) clangd: ${state}`;
}

export interface StatusItem {
	text: string;
	tooltip: unknown;
	show(): void;
	hide(): void;
}

/**
 * Tracks clangd's per-file state (`textDocument/clangd.fileStatus`, enabled with the `clangdFileStatus`
 * initialization option) and shows the active file's state in a status bar item, so a slow first preamble reads as
 * "clangd: parsing includes" instead of a hover stuck on "Loading...".
 *
 * Before the first notification arrives the item says `starting`, covering the clangd.wasm download and boot.
 * A file with no entry (never opened, or the active editor is not C/C++) shows nothing.
 */
export class ClangdStatus {
	private readonly states = new Map<string, string>();
	private starting = true;
	private active: string | undefined;

	constructor(private readonly item: StatusItem) { this.render(); }

	setActive(uri: string | undefined): void {
		this.active = uri;
		this.render();
	}

	fileStatus(uri: string, state: string): void {
		this.starting = false;
		if (state === 'idle') { this.states.delete(uri); } else { this.states.set(uri, state); }
		this.render();
	}

	/** The server answered `initialize`; with no file open yet there is nothing more to wait for. */
	ready(): void {
		this.starting = false;
		this.render();
	}

	private render(): void {
		const state = this.starting ? 'starting' : this.active === undefined ? undefined : this.states.get(this.active);
		const label = statusLabel(state);
		if (label === undefined) { this.item.hide(); return; }
		this.item.text = label;
		this.item.tooltip = 'vscwClang: the clangd language server is working on this file; hover and completion may wait until it finishes.';
		this.item.show();
	}
}
