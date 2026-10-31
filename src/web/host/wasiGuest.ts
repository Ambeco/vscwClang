/** Errno names a `GuestServices` method may throw (see `GuestFsError`). */
export type FsErrno = 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EACCES' | 'EIO' | 'ENOSYS';

export class GuestFsError extends Error {
	constructor(readonly code: FsErrno, message?: string) { super(message ?? code); }
}

export interface GuestStat { type: 'file' | 'dir'; size: number; mtimeMs: number }
export interface GuestDirEntry { name: string; type: 'file' | 'dir' }

/**
 * Everything the guest's WASI imports need from outside the Worker; every method is synchronous and may block.
 *
 * Paths are absolute, normalized guest paths. Failing methods throw `GuestFsError`.
 */
export interface GuestServices {
	/** Blocks until input is available; an empty result is end of input. */
	readStdin(maxBytes: number): Uint8Array;
	writeOutput(fd: 1 | 2, data: Uint8Array): void;
	stat(path: string): GuestStat;
	readFile(path: string): Uint8Array;
	writeFile(path: string, data: Uint8Array): void;
	readDirectory(path: string): GuestDirEntry[];
	createDirectory(path: string): void;
	delete(path: string): void;
	rename(from: string, to: string): void;
	/** Sleeps the calling thread; interruptible only by terminating its Worker. */
	sleep(ms: number): void;
}

export interface GuestOptions {
	args: string[];
	env: Record<string, string>;
	/** Guest directories handed to the program as preopens, in fd order starting at 3. */
	preopens: string[];
	services: GuestServices;
	/** stdio reports as a terminal, so `isatty` is true and libc line-buffers stdout. Only for user programs. */
	terminal?: boolean;
	/** The module's imported shared memory (wasi-threads modules own none, so the instance exports no `memory`). */
	memory?: WebAssembly.Memory;
}

export type GuestResult =
	| { kind: 'exit'; code: number }
	| { kind: 'trap'; message: string };

/** Thrown by `proc_exit` to unwind the guest. */
class GuestExit {
	constructor(readonly code: number) {}
}

const ERRNO = {
	SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, FAULT: 21, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54,
	NOTEMPTY: 55, SPIPE: 70, NOTCAPABLE: 76,
} as const;
const FS_ERRNO: Record<FsErrno, number> = {
	ENOENT: ERRNO.NOENT, EEXIST: ERRNO.EXIST, ENOTDIR: ERRNO.NOTDIR, EISDIR: ERRNO.ISDIR, ENOTEMPTY: ERRNO.NOTEMPTY,
	EACCES: ERRNO.ACCES, EIO: ERRNO.IO, ENOSYS: ERRNO.NOSYS,
};
const FILETYPE = { characterDevice: 2, directory: 3, regular: 4 } as const;
const OFLAGS = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const;
const FDFLAGS_APPEND = 1;
const ALL_RIGHTS = 0x1fffffffn;
// wasi-libc's isatty() wants a character device without FD_SEEK (1 << 2) or FD_TELL (1 << 5).
const TERMINAL_RIGHTS = ALL_RIGHTS & ~(1n << 2n | 1n << 5n);

/** File contents shared by every descriptor open on one path; written back when the last one closes. */
interface FileData { bytes: Uint8Array; size: number; dirty: boolean; refs: number }

type Fd =
	| { kind: 'stdin' | 'stdout' | 'stderr' }
	| { kind: 'dir'; path: string; root: string }
	| { kind: 'file'; path: string; root: string; data: FileData; pos: number; append: boolean };

class ErrnoSignal {
	constructor(readonly errno: number) {}
}

/**
 * WASI preview 1 for one guest instance, over synchronous `GuestServices` (vscode-free, so it runs in a Worker or in a node test).
 *
 * Regular files are read whole when opened and written back whole when the last descriptor on them closes (or on
 * `fd_sync`, and when the program ends or traps), so a program that never closes a file still saves it at exit, but
 * another process sees its writes only then. Symlinks, hard links and sockets are not supported.
 *
 * A trap in the guest does not escape: `start` returns `{ kind: 'trap' }` with the engine's message.
 */
export class GuestWasi {
	readonly imports: WebAssembly.ModuleImports;
	private memory!: WebAssembly.Memory;
	private readonly fds = new Map<number, Fd>();
	private readonly files = new Map<string, FileData>();
	private readonly inodes = new Map<string, bigint>();
	private nextFd: number;
	private readonly services: GuestServices;
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();
	private readonly start0 = performance.now();
	private exitCode: number | undefined;

	constructor(private readonly options: GuestOptions) {
		this.services = options.services;
		this.fds.set(0, { kind: 'stdin' }).set(1, { kind: 'stdout' }).set(2, { kind: 'stderr' });
		options.preopens.forEach((path, i) => this.fds.set(3 + i, { kind: 'dir', path, root: path }));
		this.nextFd = 3 + options.preopens.length;
		this.imports = this.makeImports();
	}

	/** Runs the instance's `_start` to its end; flushes unsaved files whatever happens. */
	start(instance: WebAssembly.Instance): GuestResult {
		this.memory = this.options.memory ?? instance.exports.memory as WebAssembly.Memory;
		const entry = instance.exports._start as (() => void) | undefined;
		if (!entry) { throw new Error('vscwClang: the module has no _start export, so it is not a WASI command. Did you mean to link an executable (not -shared or --no-entry)?'); }
		return this.guarded(entry);
	}

	/**
	 * Runs a spawned thread's `wasi_thread_start` to its end. Returns undefined when it returns normally; an exit
	 * (`proc_exit` or an uncaught trap) in any thread ends the whole process, so the caller must report those.
	 */
	runThread(instance: WebAssembly.Instance, tid: number, startArg: number): GuestResult | undefined {
		this.memory = this.options.memory!;
		const entry = instance.exports.wasi_thread_start as ((tid: number, startArg: number) => void) | undefined;
		if (!entry) { throw new Error('vscwClang: the module has no wasi_thread_start export, so it cannot run threads. Did you mean to link with -pthread (target wasm32-wasip1-threads)?'); }
		const result = this.guarded(() => entry(tid, startArg));
		return result.kind === 'exit' && result.code === 0 && this.exitCode === undefined ? undefined : result;
	}

	private guarded(entry: () => void): GuestResult {
		try {
			entry();
			return { kind: 'exit', code: 0 };
		} catch (e) {
			// A C++ `catch (...)` (or a cleanup `catch_all`, as in `std::terminate`) can swallow the unwinding exception, so the first `proc_exit` code wins whatever ends `_start`.
			if (this.exitCode !== undefined) { return { kind: 'exit', code: this.exitCode }; }
			if (e instanceof WebAssembly.RuntimeError) { return { kind: 'trap', message: `RuntimeError: ${e.message}` }; }
			// A stack overflow surfaces as a plain RangeError in V8.
			if (e instanceof RangeError) { return { kind: 'trap', message: `RangeError: ${e.message}` }; }
			// An uncaught C++ `throw` escapes _start as a wasm exception, not a RuntimeError.
			if (typeof WebAssembly.Exception === 'function' && e instanceof WebAssembly.Exception) { return { kind: 'trap', message: 'uncaught C++ exception (type and message unavailable: it was thrown outside main(), e.g. in a static constructor)' }; }
			throw e;
		} finally {
			this.flushAll();
		}
	}

	flushAll(): void {
		for (const [path, data] of this.files) { this.flush(path, data); }
	}

	private flush(path: string, data: FileData): void {
		if (!data.dirty) { return; }
		this.services.writeFile(path, data.bytes.slice(0, data.size));
		data.dirty = false;
	}

	private view(): DataView { return new DataView(this.memory.buffer); }
	private bytes(): Uint8Array { return new Uint8Array(this.memory.buffer); }

	private readString(ptr: number, len: number): string {
		return this.decoder.decode(this.bytes().slice(ptr, ptr + len));
	}

	private makeImports(): WebAssembly.ModuleImports {
		const guard = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A): number => {
			try { fn(...args); return ERRNO.SUCCESS; } catch (e) {
				if (e instanceof ErrnoSignal) { return e.errno; }
				if (e instanceof GuestFsError) { return FS_ERRNO[e.code]; }
				throw e;
			}
		};
		const fail = (errno: number): never => { throw new ErrnoSignal(errno); };
		const enosys = guard(() => fail(ERRNO.NOSYS));
		return {
			args_sizes_get: guard((argc: number, bufSize: number) => {
				const v = this.view();
				v.setUint32(argc, this.options.args.length, true);
				v.setUint32(bufSize, this.options.args.reduce((n, a) => n + this.encoder.encode(a).length + 1, 0), true);
			}),
			args_get: guard((argv: number, buf: number) => this.writeStrings(this.options.args, argv, buf)),
			environ_sizes_get: guard((count: number, bufSize: number) => {
				const strings = this.envStrings();
				const v = this.view();
				v.setUint32(count, strings.length, true);
				v.setUint32(bufSize, strings.reduce((n, a) => n + this.encoder.encode(a).length + 1, 0), true);
			}),
			environ_get: guard((environ: number, buf: number) => this.writeStrings(this.envStrings(), environ, buf)),
			clock_res_get: guard((_id: number, out: number) => this.view().setBigUint64(out, 1000n, true)),
			clock_time_get: guard((id: number, _precision: bigint, out: number) => {
				const ns = id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round((performance.now() - this.start0) * 1e6));
				this.view().setBigUint64(out, ns, true);
			}),
			random_get: guard((ptr: number, len: number) => {
				// getRandomValues rejects views of a shared memory, so fill a copy.
				const random = new Uint8Array(len);
				for (let off = 0; off < len; off += 65536) { crypto.getRandomValues(random.subarray(off, Math.min(len, off + 65536))); }
				this.bytes().set(random, ptr);
			}),
			sched_yield: guard(() => undefined),
			proc_exit: (code: number) => { this.exitCode ??= code; throw new GuestExit(code); },
			proc_raise: enosys,
			poll_oneoff: guard((input: number, output: number, count: number, eventsOut: number) => this.pollOneoff(input, output, count, eventsOut)),

			fd_prestat_get: guard((fd: number, out: number) => {
				const entry = this.fds.get(fd);
				if (!entry || entry.kind !== 'dir' || entry.path !== entry.root) { return fail(ERRNO.BADF); }
				const v = this.view();
				v.setUint8(out, 0);
				v.setUint32(out + 4, this.encoder.encode(entry.path).length, true);
			}),
			fd_prestat_dir_name: guard((fd: number, ptr: number, len: number) => {
				const entry = this.fds.get(fd);
				if (!entry || entry.kind !== 'dir') { return fail(ERRNO.BADF); }
				this.bytes().set(this.encoder.encode(entry.path).subarray(0, len), ptr);
			}),
			fd_close: guard((fd: number) => this.closeFd(fd)),
			fd_read: guard((fd: number, iovs: number, iovsLen: number, out: number) => this.view().setUint32(out, this.readFd(fd, iovs, iovsLen, undefined), true)),
			fd_pread: guard((fd: number, iovs: number, iovsLen: number, offset: bigint, out: number) => this.view().setUint32(out, this.readFd(fd, iovs, iovsLen, Number(offset)), true)),
			fd_write: guard((fd: number, iovs: number, iovsLen: number, out: number) => this.view().setUint32(out, this.writeFd(fd, iovs, iovsLen, undefined), true)),
			fd_pwrite: guard((fd: number, iovs: number, iovsLen: number, offset: bigint, out: number) => this.view().setUint32(out, this.writeFd(fd, iovs, iovsLen, Number(offset)), true)),
			fd_seek: guard((fd: number, offset: bigint, whence: number, out: number) => {
				const entry = this.fds.get(fd);
				if (!entry) { return fail(ERRNO.BADF); }
				if (entry.kind !== 'file') { return fail(ERRNO.SPIPE); }
				const base = whence === 0 ? 0 : whence === 1 ? entry.pos : entry.data.size;
				const next = base + Number(offset);
				if (next < 0) { return fail(ERRNO.INVAL); }
				entry.pos = next;
				this.view().setBigUint64(out, BigInt(next), true);
			}),
			fd_tell: guard((fd: number, out: number) => {
				const entry = this.fds.get(fd);
				if (!entry) { return fail(ERRNO.BADF); }
				if (entry.kind !== 'file') { return fail(ERRNO.SPIPE); }
				this.view().setBigUint64(out, BigInt(entry.pos), true);
			}),
			fd_sync: guard((fd: number) => this.syncFd(fd)),
			fd_datasync: guard((fd: number) => this.syncFd(fd)),
			fd_advise: guard(() => undefined),
			fd_allocate: guard((fd: number, offset: bigint, len: bigint) => {
				const entry = this.fds.get(fd);
				if (entry?.kind !== 'file') { return fail(ERRNO.BADF); }
				if (Number(offset + len) > entry.data.size) { this.resize(entry.data, Number(offset + len)); }
			}),
			fd_fdstat_get: guard((fd: number, out: number) => {
				const entry = this.fds.get(fd);
				if (!entry) { return fail(ERRNO.BADF); }
				const v = this.view();
				v.setUint8(out, entry.kind === 'dir' ? FILETYPE.directory : entry.kind === 'file' ? FILETYPE.regular : FILETYPE.characterDevice);
				v.setUint16(out + 2, entry.kind === 'file' && entry.append ? FDFLAGS_APPEND : 0, true);
				const stdio = entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr';
				v.setBigUint64(out + 8, stdio && this.options.terminal ? TERMINAL_RIGHTS : ALL_RIGHTS, true);
				v.setBigUint64(out + 16, ALL_RIGHTS, true);
			}),
			fd_fdstat_set_flags: guard((fd: number, flags: number) => {
				const entry = this.fds.get(fd);
				if (!entry) { return fail(ERRNO.BADF); }
				if (entry.kind === 'file') { entry.append = (flags & FDFLAGS_APPEND) !== 0; }
			}),
			fd_fdstat_set_rights: guard((fd: number) => { if (!this.fds.has(fd)) { fail(ERRNO.BADF); } }),
			fd_filestat_get: guard((fd: number, out: number) => {
				const entry = this.fds.get(fd);
				if (!entry) { return fail(ERRNO.BADF); }
				if (entry.kind === 'file') { this.writeFilestat(out, entry.path, FILETYPE.regular, entry.data.size, Date.now()); }
				else if (entry.kind === 'dir') { this.writeFilestat(out, entry.path, FILETYPE.directory, 0, Date.now()); }
				else { this.writeFilestat(out, `<${entry.kind}>`, FILETYPE.characterDevice, 0, Date.now()); }
			}),
			fd_filestat_set_size: guard((fd: number, size: bigint) => {
				const entry = this.fds.get(fd);
				if (entry?.kind !== 'file') { return fail(ERRNO.BADF); }
				this.resize(entry.data, Number(size));
			}),
			fd_filestat_set_times: guard(() => undefined),
			fd_renumber: guard((from: number, to: number) => {
				const entry = this.fds.get(from);
				if (!entry) { return fail(ERRNO.BADF); }
				if (this.fds.has(to)) { this.closeFd(to); }
				this.fds.set(to, entry);
				this.fds.delete(from);
			}),
			fd_readdir: guard((fd: number, buf: number, bufLen: number, cookie: bigint, out: number) => this.view().setUint32(out, this.readDir(fd, buf, bufLen, Number(cookie)), true)),

			path_open: guard((dirfd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number, _rightsBase: bigint, _rightsInheriting: bigint, fdflags: number, out: number) => {
				const { path, root } = this.resolve(dirfd, this.readString(pathPtr, pathLen));
				this.view().setUint32(out, this.openPath(path, root, oflags, fdflags), true);
			}),
			path_filestat_get: guard((dirfd: number, _flags: number, pathPtr: number, pathLen: number, out: number) => {
				const { path } = this.resolve(dirfd, this.readString(pathPtr, pathLen));
				const open = this.files.get(path);
				const stat = this.services.stat(path);
				this.writeFilestat(out, path, stat.type === 'dir' ? FILETYPE.directory : FILETYPE.regular, open ? open.size : stat.size, stat.mtimeMs);
			}),
			path_filestat_set_times: guard(() => undefined),
			path_create_directory: guard((dirfd: number, pathPtr: number, pathLen: number) => this.services.createDirectory(this.resolve(dirfd, this.readString(pathPtr, pathLen)).path)),
			path_remove_directory: guard((dirfd: number, pathPtr: number, pathLen: number) => {
				const { path } = this.resolve(dirfd, this.readString(pathPtr, pathLen));
				if (this.services.stat(path).type !== 'dir') { return fail(ERRNO.NOTDIR); }
				this.services.delete(path);
			}),
			path_unlink_file: guard((dirfd: number, pathPtr: number, pathLen: number) => {
				const { path } = this.resolve(dirfd, this.readString(pathPtr, pathLen));
				if (this.services.stat(path).type === 'dir') { return fail(ERRNO.ISDIR); }
				this.files.delete(path);
				this.services.delete(path);
			}),
			path_rename: guard((fromDir: number, fromPtr: number, fromLen: number, toDir: number, toPtr: number, toLen: number) => {
				const from = this.resolve(fromDir, this.readString(fromPtr, fromLen)).path;
				const to = this.resolve(toDir, this.readString(toPtr, toLen)).path;
				const open = this.files.get(from);
				if (open) { this.flush(from, open); this.files.delete(from); this.files.delete(to); }
				this.services.rename(from, to);
			}),
			path_symlink: enosys,
			// No symlinks exist, so every existing path is "not a link"; libc's realpath needs INVAL here, not NOSYS.
			path_readlink: guard((dirfd: number, pathPtr: number, pathLen: number) => {
				this.services.stat(this.resolve(dirfd, this.readString(pathPtr, pathLen)).path);
				fail(ERRNO.INVAL);
			}),
			path_link: enosys,
			sock_accept: enosys,
			sock_recv: enosys,
			sock_send: enosys,
			sock_shutdown: enosys,
		};
	}

	private envStrings(): string[] {
		return Object.entries(this.options.env).map(([k, v]) => `${k}=${v}`);
	}

	private writeStrings(strings: string[], pointers: number, buf: number): void {
		const v = this.view();
		const mem = this.bytes();
		let at = buf;
		strings.forEach((s, i) => {
			v.setUint32(pointers + i * 4, at, true);
			const encoded = this.encoder.encode(s);
			mem.set(encoded, at);
			mem[at + encoded.length] = 0;
			at += encoded.length + 1;
		});
	}

	// Clang drops include directories whose (device, inode) match an earlier one, so each path needs its own inode.
	private inodeOf(path: string): bigint {
		let ino = this.inodes.get(path);
		if (ino === undefined) { ino = BigInt(this.inodes.size + 1); this.inodes.set(path, ino); }
		return ino;
	}

	private writeFilestat(out: number, path: string, type: number, size: number, mtimeMs: number): void {
		const v = this.view();
		new Uint8Array(this.memory.buffer, out, 64).fill(0);
		v.setBigUint64(out + 8, this.inodeOf(path), true);
		v.setUint8(out + 16, type);
		v.setBigUint64(out + 24, 1n, true);
		v.setBigUint64(out + 32, BigInt(size), true);
		const ns = BigInt(Math.round(mtimeMs)) * 1_000_000n;
		v.setBigUint64(out + 40, ns, true);
		v.setBigUint64(out + 48, ns, true);
		v.setBigUint64(out + 56, ns, true);
	}

	/** Joins a path to a directory descriptor's path; `..` may not climb out of the preopen. */
	private resolve(dirfd: number, relative: string): { path: string; root: string } {
		const entry = this.fds.get(dirfd);
		if (!entry) { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind !== 'dir') { throw new ErrnoSignal(ERRNO.NOTDIR); }
		const parts = entry.path === '/' ? [] : entry.path.split('/').filter(Boolean);
		const floor = entry.root === '/' ? 0 : entry.root.split('/').filter(Boolean).length;
		for (const part of relative.split('/')) {
			if (part === '' || part === '.') { continue; }
			if (part === '..') {
				if (parts.length <= floor) { throw new ErrnoSignal(ERRNO.NOTCAPABLE); }
				parts.pop();
			} else { parts.push(part); }
		}
		return { path: '/' + parts.join('/'), root: entry.root };
	}

	private openPath(path: string, root: string, oflags: number, fdflags: number): number {
		let stat: GuestStat | undefined;
		try { stat = this.services.stat(path); } catch (e) {
			if (!(e instanceof GuestFsError && e.code === 'ENOENT')) { throw e; }
		}
		if (stat?.type === 'dir') {
			const fd = this.nextFd++;
			this.fds.set(fd, { kind: 'dir', path, root });
			return fd;
		}
		if (oflags & OFLAGS.directory) { throw new ErrnoSignal(stat ? ERRNO.NOTDIR : ERRNO.NOENT); }
		if (stat && (oflags & OFLAGS.creat) && (oflags & OFLAGS.excl)) { throw new ErrnoSignal(ERRNO.EXIST); }
		if (!stat && !(oflags & OFLAGS.creat)) { throw new ErrnoSignal(ERRNO.NOENT); }
		let data = this.files.get(path);
		if (!data) {
			const bytes = stat ? this.services.readFile(path) : new Uint8Array(0);
			data = { bytes: bytes.slice(), size: bytes.length, dirty: false, refs: 0 };
			if (!stat) {
				this.services.writeFile(path, new Uint8Array(0));
			}
			this.files.set(path, data);
		}
		if (oflags & OFLAGS.trunc) { this.resize(data, 0); }
		data.refs++;
		const fd = this.nextFd++;
		this.fds.set(fd, { kind: 'file', path, root, data, pos: 0, append: (fdflags & FDFLAGS_APPEND) !== 0 });
		return fd;
	}

	private resize(data: FileData, size: number): void {
		if (size > data.bytes.length) {
			const grown = new Uint8Array(Math.max(size, data.bytes.length * 2, 64));
			grown.set(data.bytes.subarray(0, data.size));
			data.bytes = grown;
		} else if (size < data.size) {
			data.bytes.fill(0, size, data.size);
		}
		data.size = size;
		data.dirty = true;
	}

	private closeFd(fd: number): void {
		const entry = this.fds.get(fd);
		if (!entry) { throw new ErrnoSignal(ERRNO.BADF); }
		this.fds.delete(fd);
		if (entry.kind === 'file' && --entry.data.refs === 0) {
			this.flush(entry.path, entry.data);
			this.files.delete(entry.path);
		}
	}

	private syncFd(fd: number): void {
		const entry = this.fds.get(fd);
		if (!entry) { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind === 'file') { this.flush(entry.path, entry.data); }
	}

	private readFd(fd: number, iovs: number, iovsLen: number, offset: number | undefined): number {
		const entry = this.fds.get(fd);
		if (!entry) { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind === 'stdout' || entry.kind === 'stderr') { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind === 'dir') { throw new ErrnoSignal(ERRNO.ISDIR); }
		let total = 0;
		for (let i = 0; i < iovsLen; i++) {
			const v = this.view();
			const ptr = v.getUint32(iovs + i * 8, true);
			const len = v.getUint32(iovs + i * 8 + 4, true);
			if (len === 0) { continue; }
			let chunk: Uint8Array;
			if (entry.kind === 'stdin') {
				// One blocking read per call: return as soon as any bytes arrived instead of waiting to fill the rest.
				if (total > 0) { break; }
				chunk = this.services.readStdin(len);
			} else if (entry.kind === 'file') {
				const at = offset ?? entry.pos;
				chunk = entry.data.bytes.subarray(at, Math.min(entry.data.size, at + len));
				if (offset === undefined) { entry.pos += chunk.length; } else { offset += chunk.length; }
			} else {
				throw new ErrnoSignal(ERRNO.BADF);
			}
			this.bytes().set(chunk, ptr);
			total += chunk.length;
			if (chunk.length < len) { break; }
		}
		return total;
	}

	private writeFd(fd: number, iovs: number, iovsLen: number, offset: number | undefined): number {
		const entry = this.fds.get(fd);
		if (!entry) { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind === 'stdin') { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind === 'dir') { throw new ErrnoSignal(ERRNO.ISDIR); }
		let total = 0;
		for (let i = 0; i < iovsLen; i++) {
			const v = this.view();
			const ptr = v.getUint32(iovs + i * 8, true);
			const len = v.getUint32(iovs + i * 8 + 4, true);
			if (len === 0) { continue; }
			const chunk = this.bytes().slice(ptr, ptr + len);
			if (entry.kind === 'file') {
				const at = offset ?? (entry.append ? entry.data.size : entry.pos);
				if (at + len > entry.data.size) { this.resize(entry.data, at + len); }
				entry.data.bytes.set(chunk, at);
				entry.data.dirty = true;
				if (offset === undefined) { entry.pos = at + len; } else { offset += len; }
			} else {
				this.services.writeOutput(entry.kind === 'stdout' ? 1 : 2, chunk);
			}
			total += len;
		}
		return total;
	}

	private readDir(fd: number, buf: number, bufLen: number, cookie: number): number {
		const entry = this.fds.get(fd);
		if (!entry) { throw new ErrnoSignal(ERRNO.BADF); }
		if (entry.kind !== 'dir') { throw new ErrnoSignal(ERRNO.NOTDIR); }
		const listing: GuestDirEntry[] = [{ name: '.', type: 'dir' }, { name: '..', type: 'dir' }, ...this.services.readDirectory(entry.path)];
		const mem = this.bytes();
		let used = 0;
		for (let i = cookie; i < listing.length; i++) {
			const name = this.encoder.encode(listing[i].name);
			const record = new Uint8Array(24 + name.length);
			const rv = new DataView(record.buffer);
			rv.setBigUint64(0, BigInt(i + 1), true);
			rv.setBigUint64(8, BigInt(i + 1), true);
			rv.setUint32(16, name.length, true);
			rv.setUint8(20, listing[i].type === 'dir' ? FILETYPE.directory : FILETYPE.regular);
			record.set(name, 24);
			const fits = Math.min(record.length, bufLen - used);
			mem.set(record.subarray(0, fits), buf + used);
			used += fits;
			// A truncated last record tells libc to retry with a bigger buffer.
			if (fits < record.length) { break; }
		}
		return used;
	}

	private pollOneoff(input: number, output: number, count: number, eventsOut: number): void {
		const v = this.view();
		let sleepMs = Infinity;
		const events: { userdata: bigint; type: number; waitMs: number }[] = [];
		for (let i = 0; i < count; i++) {
			const base = input + i * 48;
			const userdata = v.getBigUint64(base, true);
			const type = v.getUint8(base + 8);
			if (type === 0) {
				const timeout = Number(v.getBigUint64(base + 24, true)) / 1e6;
				const absolute = (v.getUint16(base + 40, true) & 1) !== 0;
				const clockId = v.getUint32(base + 16, true);
				const now = clockId === 0 ? Date.now() : performance.now() - this.start0;
				const waitMs = Math.max(0, absolute ? timeout - now : timeout);
				sleepMs = Math.min(sleepMs, waitMs);
				events.push({ userdata, type, waitMs });
			} else {
				// fd readiness: treat as ready; the read or write itself blocks if it must.
				sleepMs = 0;
				events.push({ userdata, type, waitMs: 0 });
			}
		}
		if (sleepMs > 0 && Number.isFinite(sleepMs)) { this.services.sleep(sleepMs); }
		const out = this.view();
		// Only the subscriptions that are due are reported; a later clock stays pending for the next poll.
		const due = events.filter(e => e.waitMs <= sleepMs);
		due.forEach((e, i) => {
			const at = output + i * 32;
			new Uint8Array(this.memory.buffer, at, 32).fill(0);
			out.setBigUint64(at, e.userdata, true);
			out.setUint8(at + 10, e.type);
		});
		out.setUint32(eventsOut, due.length, true);
	}
}
