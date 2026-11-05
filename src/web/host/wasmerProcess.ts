import type { ProcessOutcome } from './guestProcess';
import { pullChanges, pushWorkspace, type FileTree, type SyncResult, type SyncOptions } from './workspaceSync';

/*
 * The slice of `@wasmer/sdk` this extension uses. The SDK cannot be bundled (it loads its own wasm and Workers from
 * its URL) and the core must not depend on it, so it is loaded at run time (`wasmerLoader.ts`) and typed here.
 */
export interface WasmerLike {
	packages: { load(wasm: Uint8Array): Promise<WasmerPackageLike> };
	createSandbox(options?: { packages?: WasmerPackageLike[]; env?: Record<string, string> }): Promise<WasmerSandboxLike>;
}
export interface WasmerPackageLike { command(name: string): unknown; readonly entrypoint?: string; readonly commands: readonly string[] }
export interface WasmerSandboxLike {
	fs: {
		writeFile(path: string, contents: Uint8Array): Promise<void>;
		readFile(path: string): Promise<Uint8Array>;
		readDir(path: string): Promise<readonly { name: string; kind: 'file' | 'directory' }[]>;
		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
		remove(path: string, options?: { recursive?: boolean }): Promise<void>;
	};
	command(selector: unknown, args?: readonly string[], options?: { cwd?: string; env?: Record<string, string> }): {
		spawn(options?: { stdin?: 'pipe' | 'closed'; stdout?: 'pipe'; stderr?: 'pipe' }): Promise<WasmerProcessLike>;
	};
	close(): Promise<void>;
}
export interface WasmerProcessLike {
	stdin: { write(data: Uint8Array): Promise<void>; close(): Promise<void> } | null;
	stdout: AsyncIterable<Uint8Array> | null;
	stderr: AsyncIterable<Uint8Array> | null;
	wait(options?: { check?: boolean }): Promise<{ exitCode: number; reason: string }>;
	terminate(options?: { gracePeriodMs?: number }): Promise<void>;
}

export interface WasmerProcessOptions {
	name: string;
	bytes: Uint8Array;
	args: string[];
	env: Record<string, string>;
	/** Guest working directory and the sandbox folder the workspace is copied into. */
	cwd: string;
	/** The host workspace, copied into the sandbox before the run and the changes copied back after it. */
	workspace?: { tree: FileTree; sync: SyncOptions };
	/** Called with a one-line note about conflicts and the like. */
	onNote?: (text: string) => void;
}

export interface WasmerProcess {
	stdin: { write(data: Uint8Array | string): Promise<void>; end(): Promise<void> };
	stdout: { onData(listener: (data: Uint8Array) => void): { dispose(): void } };
	stderr: { onData(listener: (data: Uint8Array) => void): { dispose(): void } };
	/** Like `PipedProcess.run`: 139 for a trap (the engine's message goes to stderr), 130 after `terminate()`. */
	run(): Promise<number>;
	/** Runs and reports how it ended; rejects never. */
	runToOutcome(): Promise<ProcessOutcome>;
	terminate(): Promise<void>;
}

class Pipe {
	private listeners: ((data: Uint8Array) => void)[] = [];
	private backlog: Uint8Array[] = [];
	onData(listener: (data: Uint8Array) => void): { dispose(): void } {
		this.listeners.push(listener);
		for (const data of this.backlog.splice(0)) { listener(data); }
		return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
	}
	emit(data: Uint8Array): void {
		if (this.listeners.length === 0) { this.backlog.push(data); } else { for (const l of this.listeners) { l(data); } }
	}
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The engine message of a wasm trap that Wasmer reports as `command execution failed: RuntimeError: js: <message>`, or undefined for other errors. */
export function wasmerTrapMessage(e: unknown): string | undefined {
	const match = /RuntimeError: (?:js: )?([^\n]*)/.exec(errorText(e));
	return match?.[1];
}

/** Adapts a sandbox folder to the sync's `FileTree`, rooted at `root` (an absolute sandbox path). */
function sandboxTree(sandbox: WasmerSandboxLike, root: string): FileTree {
	const abs = (path: string): string => (path ? `${root}/${path}` : root);
	return {
		async readDir(path) {
			const entries = await sandbox.fs.readDir(abs(path));
			return entries.map(e => ({ name: e.name, isDir: e.kind === 'directory' }));
		},
		readFile: path => sandbox.fs.readFile(abs(path)),
		async writeFile(path, data) {
			const slash = path.lastIndexOf('/');
			if (slash > 0) { await sandbox.fs.mkdir(abs(path.slice(0, slash)), { recursive: true }); }
			await sandbox.fs.writeFile(abs(path), data);
		},
		remove: path => sandbox.fs.remove(abs(path), { recursive: true }),
		mkdir: path => sandbox.fs.mkdir(abs(path), { recursive: true }),
	};
}

/**
 * Runs a user program in a Wasmer (WASIX) sandbox with piped stdio; the Wasmer counterpart of `createWorkerProcess`.
 *
 * Each run gets a fresh sandbox. The workspace is copied into `cwd` first and only changed files are copied back
 * afterwards, also after a trap (see `workspaceSync.ts`), so files appear on the host when the program ends, not
 * while it runs. Input written before the program starts is kept until it does. `/tmp` is the sandbox's own and
 * disappears with it, and there is no persistent `/home/user`.
 */
export function createWasmerProcess(wasmer: WasmerLike, options: WasmerProcessOptions): WasmerProcess {
	const stdout = new Pipe(), stderr = new Pipe();
	const pendingInput: (Uint8Array | 'end')[] = [];
	let proc: WasmerProcessLike | undefined;
	let terminated = false;
	const encoder = new TextEncoder();
	const forward = (item: Uint8Array | 'end'): Promise<void> => {
		if (!proc?.stdin) { pendingInput.push(item); return Promise.resolve(); }
		return item === 'end' ? proc.stdin.close() : proc.stdin.write(item);
	};
	const pump = async (stream: AsyncIterable<Uint8Array> | null, pipe: Pipe): Promise<void> => {
		if (stream) { for await (const chunk of stream) { pipe.emit(chunk); } }
	};

	async function runToOutcome(): Promise<ProcessOutcome> {
		let sandbox: WasmerSandboxLike | undefined;
		let snapshot: Awaited<ReturnType<typeof pushWorkspace>> | undefined;
		let tree: FileTree | undefined;
		try {
			const pkg = await wasmer.packages.load(options.bytes);
			sandbox = await wasmer.createSandbox({ packages: [pkg], env: options.env });
			if (options.workspace) {
				tree = sandboxTree(sandbox, options.cwd);
				snapshot = await pushWorkspace(options.workspace.tree, tree, options.workspace.sync);
			}
			if (terminated) { return { kind: 'terminated' }; }
			proc = await sandbox.command(pkg.command(pkg.entrypoint ?? pkg.commands[0]), options.args, { cwd: options.cwd, env: options.env }).spawn({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
			for (const item of pendingInput.splice(0)) { await forward(item); }
			const pumps = Promise.all([pump(proc.stdout, stdout), pump(proc.stderr, stderr)]);
			let outcome: ProcessOutcome;
			try {
				const result = await proc.wait({ check: false });
				outcome = result.reason === 'terminated' || terminated ? { kind: 'terminated' } : { kind: 'exit', code: result.exitCode };
			} catch (e) {
				const trap = wasmerTrapMessage(e);
				outcome = terminated ? { kind: 'terminated' } : trap !== undefined ? { kind: 'trap', message: trap } : { kind: 'failed', message: errorText(e) };
			}
			await pumps.catch(() => undefined);
			return outcome;
		} catch (e) {
			return { kind: 'failed', message: errorText(e) };
		} finally {
			if (sandbox && tree && snapshot && options.workspace) {
				try {
					const synced = await pullChanges(options.workspace.tree, tree, snapshot, options.workspace.sync);
					noteConflicts(synced);
				} catch (e) {
					options.onNote?.(`could not copy files back to the workspace: ${errorText(e)}`);
				}
			}
			await sandbox?.close().catch(() => undefined);
		}
	}
	function noteConflicts(synced: SyncResult): void {
		if (synced.conflicts.length > 0) {
			options.onNote?.(`left ${synced.conflicts.slice(0, 5).join(', ')}${synced.conflicts.length > 5 ? ` and ${synced.conflicts.length - 5} more` : ''} unchanged: edited in the editor while the program ran`);
		}
	}

	return {
		stdin: { write: data => forward(typeof data === 'string' ? encoder.encode(data) : data), end: () => forward('end') },
		stdout, stderr,
		runToOutcome,
		async run() {
			const outcome = await runToOutcome();
			switch (outcome.kind) {
				case 'exit': return outcome.code;
				case 'trap': stderr.emit(encoder.encode(`${options.name}: crashed inside WebAssembly: ${outcome.message}\n`)); return 139;
				case 'terminated': return 130;
				case 'failed': throw new Error(`vscwClang: ${options.name} could not run: ${outcome.message}`);
			}
		},
		async terminate() {
			terminated = true;
			await proc?.terminate().catch(() => undefined);
		},
	};
}
