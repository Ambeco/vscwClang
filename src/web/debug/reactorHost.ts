import type { WorkerThreads } from '../host/workerThreads';
import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI, type Fd } from '@bjorn3/browser_wasi_shim';

/** The debuggee's linear memory as the reactor sees it; `read` may return fewer bytes than asked (a short read). */
export interface TargetMemory {
	read(addr: number, size: number): Uint8Array;
	write?(addr: number, data: Uint8Array): number;
}

export interface StopFrame {
	/** DWARF code address of the frame (call site for outer frames). */
	pc: number;
	/** Index of the wasm local holding this frame's frame base (`wasmScan.scanProgram().frameBaseLocals`). */
	frameBaseLocal: number;
	/** That local's value: the frame's `__stack_pointer`. */
	sp: number;
}

/** One row of the Variables pane. */
export interface VariableInfo {
	/** Opaque; pass to `ReactorHost.variables` to list this value's children. Valid only for the stop it came from. */
	path: string;
	name: string;
	type: string;
	/** The data formatter's summary, else the value, else why there is none. Empty for an aggregate with no summary. */
	value: string;
	hasChildren: boolean;
}

const GUEST_DIR = '/work';
const TARGET_FILE = 'target.wasm';
const OUT_SIZE = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ReactorExports {
	memory: WebAssembly.Memory;
	_initialize(): void;
	wasm_dbg_alloc(size: number): number;
	wasm_dbg_free(ptr: number): void;
	wasm_dbg_get_last_error(out: number, size: number): number;
	wasm_dbg_init(): number;
	wasm_dbg_create_target(path: number): number;
	wasm_dbg_set_stop(pcs: number, n: number, idx: number, wasmIdx: number, vals: number, nvals: number): void;
	wasm_dbg_resolve_pc(pc: bigint, out: number, size: number): number;
	wasm_dbg_get_backtrace(out: number, size: number): number;
	wasm_dbg_format_value(frame: number, expr: number, out: number, size: number): number;
	wasm_dbg_get_variables(frame: number, path: number, out: number, size: number): number;
}

/**
 * Wraps `lldb-wasm-reactor.wasm`, the single-threaded lldb build used purely as a symbol/value decoding library.
 *
 * The reactor is not a debugger: there is no process control. After `createTarget` (the linked program's bytes, which
 * must contain DWARF), the host calls `setStop` with the call stack at each stop and then asks for line mapping
 * (`resolvePc`, `backtrace`) or pretty-printed values (`formatValue`). The reactor reads the debuggee's memory only
 * through the `TargetMemory` given to `create`, so it can be swapped per stop with `setMemory`.
 *
 * `formatValue` handles variable paths only (`x`, `x->y.z`, `arr[3]`), by decision no expression evaluator. Every
 * method throws with the reactor's own last-error text on failure. Runs on the extension host with a small in-memory
 * WASI; calls are synchronous and not reentrant.
 */
export class ReactorHost {
	private memory: TargetMemory = { read() { throw new Error('vscwClang: the debuggee memory is not attached yet; call setMemory() before formatValue().'); } };
	private targetBytes: File;

	private threads: WorkerThreads | undefined;

	private constructor(private readonly exp: ReactorExports, targetBytes: File) {
		this.targetBytes = targetBytes;
	}

	/**
	 * `wasm` is the reactor's binary. A wasi-threads build imports its memory (limits read from the bytes) and starts
	 * threads while loading debug info, so it needs `threads`; without it `thread-spawn` fails and lldb aborts.
	 */
	static async create(wasm: Uint8Array, memory?: TargetMemory, log: (line: string) => void = () => undefined, threads?: WorkerThreads): Promise<ReactorHost> {
		const target = new File(new Uint8Array(0));
		const fds: Fd[] = [
			new OpenFile(new File(new Uint8Array(0))),
			ConsoleStdout.lineBuffered(line => log(`[lldb] ${line}`)),
			ConsoleStdout.lineBuffered(line => log(`[lldb] ${line}`)),
			new PreopenDirectory(GUEST_DIR, new Map([[TARGET_FILE, target]])),
		];
		const wasi = new WASI(['lldb-wasm-reactor'], [], fds, { debug: false });
		let host: ReactorHost | undefined;
		const module = await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>);
		// lldb reads the target's file (and so its DWARF) from pool threads too, which have their own descriptor tables.
		const threaded = threads?.imports(module, wasm, { preopens: [GUEST_DIR], files: () => ({ [`${GUEST_DIR}/${TARGET_FILE}`]: target.data }) });
		const instance = await WebAssembly.instantiate(module, {
			wasi_snapshot_preview1: wasi.wasiImport,
			...threaded?.imports,
			wasm_dbg: {
				read_memory: (addr: bigint, buf: number, size: number) => host!.hostRead(Number(addr), buf, size),
				write_memory: (addr: bigint, buf: number, size: number) => host!.hostWrite(Number(addr), buf, size),
			},
		});
		const exp = { ...instance.exports, memory: threaded?.memory ?? instance.exports.memory } as unknown as ReactorExports;
		wasi.initialize({ exports: { memory: exp.memory, _initialize: exp._initialize } });
		host = new ReactorHost(exp, target);
		host.threads = threads;
		if (memory) { host.memory = memory; }
		if (exp.wasm_dbg_init() !== 0) { throw new Error(`vscwClang: lldb-wasm-reactor failed to initialize: ${host.lastError()}`); }
		return host;
	}

	setMemory(memory: TargetMemory): void { this.memory = memory; }

	/** Ends the reactor's threads (if it has any); the host is unusable afterwards. */
	dispose(): void { this.threads?.dispose(); }

	/** Loads the program (with DWARF) to decode; replaces any earlier target. */
	createTarget(program: Uint8Array): void {
		this.targetBytes.data = program;
		this.withCString(`${GUEST_DIR}/${TARGET_FILE}`, path => {
			if (this.exp.wasm_dbg_create_target(path) !== 0) {
				throw new Error(`vscwClang: lldb could not load the program's debug info: ${this.lastError()}. Did you mean to build in debug mode (-g)?`);
			}
		});
	}

	/** `"/workspace/file.cpp:12"`, or a function/symbol name or bare address when there is no line info. */
	resolvePc(pc: number): string {
		return this.outBuffer(out => this.exp.wasm_dbg_resolve_pc(BigInt(pc), out, OUT_SIZE), `resolve pc 0x${pc.toString(16)}`);
	}

	/** Frames innermost first, as for the DAP stack trace. */
	setStop(frames: StopFrame[]): void {
		this.withTyped(BigUint64Array, frames.map(f => BigInt(f.pc)), pcs =>
			this.withTyped(Uint32Array, frames.map((_, i) => i), idx =>
				this.withTyped(Uint32Array, frames.map(f => f.frameBaseLocal), local =>
					this.withTyped(BigUint64Array, frames.map(f => BigInt(f.sp)), vals => {
						this.exp.wasm_dbg_set_stop(pcs, frames.length, idx, local, vals, frames.length);
					}))));
	}

	/** One `#n file:line` entry per frame of the last `setStop`. */
	backtrace(): string[] {
		return this.outBuffer(out => this.exp.wasm_dbg_get_backtrace(out, OUT_SIZE), 'get the backtrace').split('\n');
	}

	formatValue(frame: number, expr: string): string {
		return this.withCString(expr, e => this.outBuffer(out => this.exp.wasm_dbg_format_value(frame, e, out, OUT_SIZE), `evaluate "${expr}" in frame ${frame}`));
	}

	/** A frame's variables (empty `path`), or the children of a variable from an earlier call. Innermost frame is 0. */
	variables(frame: number, path = ''): VariableInfo[] {
		if (typeof this.exp.wasm_dbg_get_variables !== 'function') {
			throw new Error('vscwClang: the toolchain\'s lldb-wasm-reactor.wasm predates variable listing (no wasm_dbg_get_variables export); did you mean to update to a newer toolchain, or set vscwclang.toolchainUrl to one built from the current llvm-project fork?');
		}
		const text = this.withCString(path, p => this.outBufferGrowing((out, size) => this.exp.wasm_dbg_get_variables(frame, p, out, size), `list the variables of frame ${frame}${path ? ` under ${path}` : ''}`));
		return text.split('\n').filter(line => line).map(line => {
			const [vpath, name, type, value, children] = line.split('\t');
			return { path: vpath, name, type, value, hasChildren: children === '1' };
		});
	}

	private hostRead(addr: number, buf: number, size: number): number {
		const bytes = this.memory.read(addr, size);
		new Uint8Array(this.exp.memory.buffer).set(bytes, buf);
		return bytes.length;
	}

	private hostWrite(addr: number, buf: number, size: number): number {
		if (!this.memory.write) { throw new Error(`vscwClang: lldb tried to write ${size} bytes of the debuggee at 0x${addr.toString(16)}, but writing is not supported.`); }
		return this.memory.write(addr, new Uint8Array(this.exp.memory.buffer, buf, size).slice());
	}

	private lastError(): string {
		return this.outBufferRaw(out => this.exp.wasm_dbg_get_last_error(out, OUT_SIZE)) || '<no detail>';
	}

	private outBufferRaw(call: (out: number) => number): string {
		const out = this.exp.wasm_dbg_alloc(OUT_SIZE);
		if (!out) { throw new Error('vscwClang: lldb-wasm-reactor is out of memory (wasm_dbg_alloc failed).'); }
		try {
			const len = call(out);
			return len < 0 ? '' : this.readCString(out, Math.min(len, OUT_SIZE - 1));
		} finally { this.exp.wasm_dbg_free(out); }
	}

	private outBuffer(call: (out: number) => number, what: string): string {
		const out = this.exp.wasm_dbg_alloc(OUT_SIZE);
		if (!out) { throw new Error('vscwClang: lldb-wasm-reactor is out of memory (wasm_dbg_alloc failed).'); }
		try {
			const len = call(out);
			if (len < 0) { throw new Error(`vscwClang: lldb could not ${what}: ${this.lastError()}`); }
			return this.readCString(out, Math.min(len, OUT_SIZE - 1));
		} finally { this.exp.wasm_dbg_free(out); }
	}

	/** Like `outBuffer`, but a result longer than `OUT_SIZE` is fetched again with a buffer that fits. */
	private outBufferGrowing(call: (out: number, size: number) => number, what: string): string {
		let size = OUT_SIZE;
		for (let attempt = 0; attempt < 2; attempt++) {
			const out = this.exp.wasm_dbg_alloc(size);
			if (!out) { throw new Error(`vscwClang: lldb-wasm-reactor is out of memory (wasm_dbg_alloc of ${size} bytes failed); did you mean to expand a smaller value?`); }
			try {
				const len = call(out, size);
				if (len < 0) { throw new Error(`vscwClang: lldb could not ${what}: ${this.lastError()}`); }
				if (len < size) { return this.readCString(out, len); }
				size = len + 1;
			} finally { this.exp.wasm_dbg_free(out); }
		}
		throw new Error(`vscwClang: lldb could not ${what}: the result kept growing between attempts.`);
	}

	private readCString(ptr: number, maxLen: number): string {
		const bytes = new Uint8Array(this.exp.memory.buffer);
		let end = ptr;
		while (end < ptr + maxLen && bytes[end] !== 0) { end++; }
		return decoder.decode(bytes.slice(ptr, end)); // slice: TextDecoder rejects views of a shared memory
	}

	private withCString<T>(text: string, use: (ptr: number) => T): T {
		const encoded = encoder.encode(text + '\0');
		const ptr = this.exp.wasm_dbg_alloc(encoded.length);
		if (!ptr) { throw new Error('vscwClang: lldb-wasm-reactor is out of memory (wasm_dbg_alloc failed).'); }
		new Uint8Array(this.exp.memory.buffer).set(encoded, ptr);
		try { return use(ptr); } finally { this.exp.wasm_dbg_free(ptr); }
	}

	private withTyped<T, A extends BigUint64Array | Uint32Array>(ctor: { new(buf: ArrayBuffer, off: number, len: number): A; BYTES_PER_ELEMENT: number }, values: (number | bigint)[], use: (ptr: number) => T): T {
		const ptr = this.exp.wasm_dbg_alloc(Math.max(1, values.length * ctor.BYTES_PER_ELEMENT));
		if (!ptr) { throw new Error('vscwClang: lldb-wasm-reactor is out of memory (wasm_dbg_alloc failed).'); }
		(new ctor(this.exp.memory.buffer, ptr, values.length) as unknown as { set(v: (number | bigint)[]): void }).set(values);
		try { return use(ptr); } finally { this.exp.wasm_dbg_free(ptr); }
	}
}
