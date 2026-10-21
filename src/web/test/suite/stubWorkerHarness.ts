import * as assert from 'assert';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';

const ROOT = process.cwd();
const bytes = (s: string) => new TextEncoder().encode(s);

/** Runs a wasm program in a worker whose stdin blocks on a shared ring buffer, as wasm-wasi-core's does. */
export class Debuggee {
	private readonly worker: Worker;
	private readonly ring: Int32Array;
	private readonly data: Uint8Array;
	private written = 0;
	stdout = '';
	exitCode: number | undefined;
	readonly exited: Promise<number>;
	onStderr: (b: Uint8Array) => void = () => undefined;
	onStdout: (b: Uint8Array) => void = () => undefined;

	constructor(wasm: Uint8Array) {
		const sab = new SharedArrayBuffer(8 + (1 << 20));
		this.ring = new Int32Array(sab, 0, 2);
		this.data = new Uint8Array(sab, 8);
		const shimUrl = pathToFileURL(join(ROOT, 'node_modules', '@bjorn3', 'browser_wasi_shim', 'dist', 'index.js')).href;
		this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { wasm, sab, shimUrl } });
		this.exited = new Promise((resolve, reject) => {
			this.worker.on('message', (m: { type: string; data?: Uint8Array; code?: number }) => {
				if (m.type === 'stdout') { this.stdout += new TextDecoder().decode(m.data); this.onStdout(m.data!); }
				else if (m.type === 'stderr') { this.onStderr(m.data!); }
				else if (m.type === 'exit') { this.exitCode = m.code; resolve(m.code!); }
			});
			this.worker.on('error', reject);
		});
	}

	write(text: string): void {
		const b = bytes(text);
		assert.ok(this.written + b.length < this.data.length, 'stdin ring buffer overflow in the test harness');
		this.data.set(b, this.written);
		this.written += b.length;
		Atomics.store(this.ring, 0, this.written);
		Atomics.notify(this.ring, 0);
	}

	terminate(): Promise<number> { return this.worker.terminate(); }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { WASI, WASIProcExit, Fd, wasi } = await import(workerData.shimUrl);
  const ring = new Int32Array(workerData.sab, 0, 2);
  const data = new Uint8Array(workerData.sab, 8);
  const charDevice = rights => () => { const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0); fdstat.fs_rights_base = BigInt(rights); return { ret: 0, fdstat }; };
  class Stdin extends Fd {
    fd_fdstat_get = charDevice(wasi.RIGHTS_FD_READ);
    fd_read(size) {
      let head;
      while ((head = Atomics.load(ring, 0)) === Atomics.load(ring, 1)) { Atomics.wait(ring, 0, head); }
      const tail = Atomics.load(ring, 1);
      const n = Math.min(size, head - tail);
      const out = data.slice(tail, tail + n);
      Atomics.store(ring, 1, tail + n);
      return { ret: 0, data: out };
    }
  }
  class Out extends Fd {
    constructor(type) { super(); this.type = type; }
    fd_fdstat_get = charDevice(wasi.RIGHTS_FD_WRITE);
    fd_write(bytes) { parentPort.postMessage({ type: this.type, data: bytes }); return { ret: 0, nwritten: bytes.length }; }
  }
  const w = new WASI(['prog'], [], [new Stdin(), new Out('stdout'), new Out('stderr')], { debug: false });
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(workerData.wasm), { wasi_snapshot_preview1: w.wasiImport });
  let code;
  try { code = w.start(instance); } catch (e) { if (e instanceof WASIProcExit) { code = e.code; } else { throw e; } }
  parentPort.postMessage({ type: 'exit', code });
})();
`;
