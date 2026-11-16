import * as vscode from 'vscode';
import { GuestProcess, StdinQueue, type TrapReport } from './guestProcess';
import { CachingGuestFs } from './cachingGuestFs';
import { RpcStats } from './rpcStats';
import { VscodeGuestFs, type GuestMount } from './vscodeGuestFs';
import type { MemoryLimits } from './sharedMemory';
import { createGuestWorker, threadOptions } from './workerHost';

/** Exit code reported for a guest that trapped, as a SIGSEGV would end a native one. */
export const TRAPPED_EXIT_CODE = 139;
/** Exit code reported for a guest stopped by `terminate()`. */
export const TERMINATED_EXIT_CODE = 130;

/** Output stream that holds data until the first listener attaches, so nothing written before `onData` is lost. */
class OutputPipe {
	private listeners: ((data: Uint8Array) => void)[] = [];
	private backlog: Uint8Array[] = [];
	onData(listener: (data: Uint8Array) => void): vscode.Disposable {
		this.listeners.push(listener);
		for (const data of this.backlog.splice(0)) { listener(data); }
		return new vscode.Disposable(() => { this.listeners = this.listeners.filter(l => l !== listener); });
	}
	emit(data: Uint8Array): void {
		if (this.listeners.length === 0) { this.backlog.push(data); } else { for (const l of this.listeners) { l(data); } }
	}
}

/**
 * The process surface clangd and Debug use (piped stdio, run, terminate), over a `GuestProcess` on the Worker host.
 *
 * `run()` resolves with the exit code: 139 after a trap (the engine's message is appended to stderr) and 130 after
 * `terminate()`. It rejects only if the guest cannot start at all.
 */
export interface PipedProcess {
	stdin?: { write(data: Uint8Array | string): Promise<void> };
	stdout?: { onData(listener: (data: Uint8Array) => void): { dispose(): void } };
	stderr?: { onData(listener: (data: Uint8Array) => void): { dispose(): void } };
	run(): Promise<number>;
	terminate(): Promise<unknown>;
	/** The shared linear memory of a wasi-threads program, which the host may read and write while it runs. */
	memory?: WebAssembly.Memory;
}

export interface WorkerProcessOptions {
	name: string;
	module: WebAssembly.Module;
	args: string[];
	env: Record<string, string>;
	mounts: GuestMount[];
	/** See `GuestOptions.terminal`. */
	terminal?: boolean;
	/** For a wasi-threads module: `sharedMemoryLimits` of its binary. */
	memoryLimits?: MemoryLimits;
	/**
	 * Debug: asked when a thread traps; returning true keeps the process (and its shared memory) alive so the trap can
	 * be shown as a stop. `run()` then resolves, as for any trap, only when `terminate()` is called. Needs `memoryLimits`
	 * (a program without shared memory has nothing a debugger could read after a trap).
	 */
	onTrap?: (trap: TrapReport) => boolean;
	/**
	 * Receives a summary of the guest's file requests every `RPC_REPORT_MS` while it is busy (the extension host serves
	 * all of them on one thread, so a threaded guest can starve it), and a last one when the guest ends.
	 */
	onRpcReport?: (text: string) => void;
}

/** How often a busy guest's file-request summary is reported. */
const RPC_REPORT_MS = 10_000;
/** A window is reported only when the extension host spent this long serving requests in it, or saw this many. */
const REPORT_BUSY_MS = 300;
const REPORT_CALLS = 5000;

export type { TrapReport };

export async function createWorkerProcess(context: vscode.ExtensionContext, options: WorkerProcessOptions): Promise<PipedProcess> {
	const stdin = new StdinQueue();
	const stdout = new OutputPipe();
	const stderr = new OutputPipe();
	const worker = await createGuestWorker(context);
	const threads = threadOptions(context, options.memoryLimits);
	const stats = options.onRpcReport ? new RpcStats() : undefined;
	const fs = new CachingGuestFs(new VscodeGuestFs(options.mounts));
	const report = (label: string, always: boolean) => {
		if (!stats || (!always && stats.busyMs < REPORT_BUSY_MS && stats.callCount < REPORT_CALLS)) { return; }
		const text = stats.takeReport(label, fs.describe());
		if (text) { options.onRpcReport?.(`${options.name} ${text}`); }
	};
	const timer = stats ? setInterval(() => report('last 10 s:', false), RPC_REPORT_MS) : undefined;
	const guest = new GuestProcess({
		module: options.module, args: [options.name, ...options.args], env: options.env,
		preopens: options.mounts.map(m => m.guestPath), terminal: options.terminal, fs, stats, stdin,
		onOutput: (fd, data) => (fd === 1 ? stdout : stderr).emit(data),
		createWorker: () => worker,
		...threads, onTrap: options.memoryLimits ? options.onTrap : undefined,
	});
	return {
		memory: threads.sharedMemory,
		stdin: { write: data => { stdin.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return Promise.resolve(); } },
		stdout, stderr,
		async run() {
			const outcome = await guest.run();
			clearInterval(timer);
			report('at exit:', true);
			stdin.end();
			switch (outcome.kind) {
				case 'exit': return outcome.code;
				case 'trap': stderr.emit(new TextEncoder().encode(`${options.name}: crashed inside WebAssembly: ${outcome.message}\n`)); return TRAPPED_EXIT_CODE;
				case 'terminated': return TERMINATED_EXIT_CODE;
				case 'failed': throw new Error(`vscwClang: ${options.name} could not run: ${outcome.message}`);
			}
		},
		terminate() { guest.terminate(); return Promise.resolve(); },
	};
}
