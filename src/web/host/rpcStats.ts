interface OpTotals { calls: number; errors: number; bytesIn: number; bytesOut: number; handlerMs: number; streamMs: number }
interface PathTotals { calls: number; bytes: number; ms: number }

const emptyOp = (): OpTotals => ({ calls: 0, errors: 0, bytesIn: 0, bytesOut: 0, handlerMs: 0, streamMs: 0 });

/**
 * Per-op totals for the requests a `SyncRpcServer` answers, to see which file operations starve the extension host.
 *
 * `handlerMs` is the time inside the file system, `streamMs` the time writing the response into the Worker's channel.
 * `takeReport` describes what happened since its last call (empty text when nothing did), so a caller can poll it.
 *
 * @helper
 */
export class RpcStats {
	private ops = new Map<string, OpTotals>();
	private paths = new Map<string, PathTotals>();

	record(op: string, path: string | undefined, bytesIn: number, bytesOut: number, handlerMs: number, streamMs: number, failed: boolean): void {
		let totals = this.ops.get(op);
		if (!totals) { totals = emptyOp(); this.ops.set(op, totals); }
		totals.calls++;
		if (failed) { totals.errors++; }
		totals.bytesIn += bytesIn;
		totals.bytesOut += bytesOut;
		totals.handlerMs += handlerMs;
		totals.streamMs += streamMs;
		if (path !== undefined && (op === 'readFile' || op === 'stat')) {
			const key = `${op} ${path}`;
			const p = this.paths.get(key) ?? { calls: 0, bytes: 0, ms: 0 };
			p.calls++; p.bytes += bytesOut; p.ms += handlerMs + streamMs;
			this.paths.set(key, p);
		}
	}

	get callCount(): number { let n = 0; for (const t of this.ops.values()) { n += t.calls; } return n; }

	/** Time spent serving requests since the last `takeReport`, which is the time the extension host was not free for anything else. */
	get busyMs(): number { let n = 0; for (const t of this.ops.values()) { n += t.handlerMs + t.streamMs; } return n; }

	takeReport(label: string, extra = ''): string {
		if (this.ops.size === 0) { return ''; }
		const kib = (n: number) => `${Math.round(n / 1024)} KiB`;
		const lines = [...this.ops.entries()].sort((a, b) => b[1].handlerMs + b[1].streamMs - (a[1].handlerMs + a[1].streamMs)).map(([op, t]) =>
			`  ${op}: ${t.calls} calls${t.errors ? ` (${t.errors} failed)` : ''}, in ${kib(t.bytesIn)}, out ${kib(t.bytesOut)}, fs ${Math.round(t.handlerMs)} ms, channel ${Math.round(t.streamMs)} ms`);
		const worst = [...this.paths.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5).map(([key, p]) =>
			`  ${key}: ${p.calls}x, ${kib(p.bytes)}, ${Math.round(p.ms)} ms`);
		this.ops = new Map();
		this.paths = new Map();
		return [`${label} file requests (${lines.length} kinds)${extra ? `; ${extra}` : ''}:`, ...lines, ...(worst.length ? ['  slowest paths:', ...worst.map(w => `  ${w}`)] : [])].join('\n');
	}
}
