// Builds GNU make 4.4.1 to wasm32-wasip1 with the fork's clang.wasm/lld.wasm (run under node:wasi) and packs it as the optional
// "make pack" the extension downloads on first Make use (design_project_model.md "Build graph"; documents/notes.md "Wasmer and Make").
//
// usage: node scripts/build-make-wasm.mjs [--release <toolchain release dir>] [--out <packDir>] [--tarball <make-4.4.1.tar.gz>] [--tag <tag>] [--pin]
//   --release  folder with bin/clang.wasm, bin/lld.wasm, sysroot/ and resource/lib/clang/<n> (default: newest ../../llvm-project/release/<tag>)
//   --out      pack folder: make.zip, manifest.json (default llvm-artifacts/makedist); deterministic, so rerunning does not change hashes
//   --tarball  a local make-4.4.1.tar.gz; otherwise downloaded from ftp.gnu.org. Either way its SHA-256 is checked against MAKE_TARBALL_SHA256
//   --tag      pack version, also the git tag in the llvm-artifacts publish repo (default make-4.4.1-1)
//   --pin      write the manifest SHA-256 and jsDelivr baseUrl into src/web/make/makePin.ts
// GNU make is GPL-3.0: the pack is downloaded, never bundled in the VSIX, and its corresponding source is this script, scripts/make-wasm/
// (the shims and config.h table) and the pinned upstream tarball (THIRD_PARTY_NOTICES.md).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { zipSync } from 'fflate';
import { strip } from './strip-wasm.mjs';
import { runWasi } from './clang-wasi.mjs';

const MAKE_VERSION = '4.4.1';
const MAKE_TARBALL_URL = `https://ftp.gnu.org/gnu/make/make-${MAKE_VERSION}.tar.gz`;
const MAKE_TARBALL_SHA256 = 'dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const repo = resolve(import.meta.dirname, '..');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function newestRelease() {
	const releases = resolve(repo, '..', '..', 'llvm-project', 'release');
	const dirs = existsSync(releases) ? readdirSync(releases).map(d => join(releases, d)).filter(d => existsSync(join(d, 'bin', 'clang.wasm'))) : [];
	dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	if (dirs.length === 0) { throw new Error(`no toolchain release with bin/clang.wasm under ${releases}; did you mean to pass --release <dir>?`); }
	return dirs[0];
}
const release = resolve(option('--release') ?? newestRelease());
const outDir = resolve(option('--out', join(repo, 'llvm-artifacts', 'makedist')));
const tag = option('--tag', `make-${MAKE_VERSION}-1`);

/** Replaces `from` with `to` exactly once; a source that no longer matches fails the build rather than patching silently. */
function patch(path, from, to) {
	const text = readFileSync(path, 'utf8');
	const count = text.split(from).length - 1;
	if (count !== 1) { throw new Error(`${path}: expected exactly one occurrence of ${JSON.stringify(from)}, found ${count}. Is this make ${MAKE_VERSION}?`); }
	writeFileSync(path, text.replace(from, to));
}

/** Feature macros for src/config.h.in; everything else stays undefined. Values of `0` become `#define X 0`. */
const defined = {
	STDC_HEADERS: 1, HAVE_ALLOCA: 1, HAVE_ALLOCA_H: 1, HAVE_ATEXIT: 1, HAVE_C_BOOL: 1, HAVE_DIRENT_H: 1, HAVE_DUP: 1, HAVE_DUP2: 1,
	HAVE_FCNTL_H: 1, HAVE_FDOPEN: 1, HAVE_GETCWD: 1, HAVE_INTMAX_T: 1, HAVE_INTTYPES_H: 1, HAVE_ISATTY: 1, HAVE_LIMITS_H: 1,
	HAVE_LOCALE_H: 1, HAVE_LONG_LONG_INT: 1, HAVE_LSTAT: 1, HAVE_MEMPCPY: 1, HAVE_MKSTEMP: 1, HAVE_MKTEMP: 1, HAVE_READLINK: 1,
	HAVE_REALPATH: 1, HAVE_SETVBUF: 1, HAVE_SIG_ATOMIC_T: 1, HAVE_STDBOOL_H: 1, HAVE_STDINT_H: 1, HAVE_STDIO_H: 1, HAVE_STDLIB_H: 1,
	HAVE_STPCPY: 1, HAVE_STRCASECMP: 1, HAVE_STRCOLL: 1, HAVE_STRDUP: 1, HAVE_STRERROR: 1, HAVE_STRINGS_H: 1, HAVE_STRING_H: 1,
	HAVE_STRNCASECMP: 1, HAVE_STRNDUP: 1, HAVE_STRTOLL: 1, HAVE_STRUCT_DIRENT_D_TYPE: 1, HAVE_SYS_PARAM_H: 1, HAVE_SYS_STAT_H: 1,
	HAVE_SYS_TIME_H: 1, HAVE_SYS_TYPES_H: 1, HAVE_SYS_WAIT_H: 1, HAVE_UINTMAX_T: 1, HAVE_UNISTD_H: 1, HAVE_UNSIGNED_LONG_LONG_INT: 1,
	HAVE_WAITPID: 1, HAVE_WCHAR_H: 1, HAVE_UMASK: 1, HAVE_GETTIMEOFDAY: 1, HAVE_CLOCK_GETTIME: 1, HAVE_SYS_SELECT_H: 1,
	HAVE_DECL_SYS_SIGLIST: 0, HAVE_DECL__SYS_SIGLIST: 0, HAVE_DECL___SYS_SIGLIST: 0, HAVE_DECL_BSD_SIGNAL: 0, HAVE_DECL_DLERROR: 0,
	HAVE_DECL_DLOPEN: 0, HAVE_DECL_DLSYM: 0, HAVE_DECL_GETLOADAVG: 0, HAVE_STRSIGNAL: 1,
	MAKE_SYMLINKS: 1, PATH_SEPARATOR_CHAR: "':'", MAKE_HOST: '"wasm32-wasi"', PACKAGE: '"make"', VERSION: `"${MAKE_VERSION}"`,
	PACKAGE_NAME: '"GNU make"', PACKAGE_STRING: `"GNU make ${MAKE_VERSION}"`, PACKAGE_VERSION: `"${MAKE_VERSION}"`, PACKAGE_TARNAME: '"make"',
	PACKAGE_BUGREPORT: '"bug-make@gnu.org"', PACKAGE_URL: '"https://www.gnu.org/software/make/"', ST_MTIM_NSEC: 'st_mtim.tv_nsec',
	FILE_TIMESTAMP_HI_RES: 1, SCCS_GET: '"get"', MK_CONFIGURE: 1,
};

async function fetchTarball() {
	const local = option('--tarball');
	const bytes = local ? readFileSync(local) : Buffer.from(await (await fetch(MAKE_TARBALL_URL)).arrayBuffer());
	const actual = sha256(bytes);
	if (actual !== MAKE_TARBALL_SHA256) {
		throw new Error(`${local ?? MAKE_TARBALL_URL} has SHA-256 ${actual}, expected ${MAKE_TARBALL_SHA256} (make ${MAKE_VERSION}). Did you mean to pass the make-${MAKE_VERSION}.tar.gz tarball?`);
	}
	return bytes;
}

const work = mkdtempSync(join(tmpdir(), 'vscwclang-make-'));
try {
	// Downloaded archives are untrusted data: extract into a fresh directory, with tar run from it and the script kept elsewhere.
	const unpack = join(work, 'unpack');
	mkdirSync(unpack);
	writeFileSync(join(unpack, 'make.tar.gz'), await fetchTarball());
	execFileSync('tar', ['-xzf', 'make.tar.gz'], { cwd: unpack });
	const src = join(unpack, `make-${MAKE_VERSION}`);

	// main: wasm-ld's `main` rename applies only to `(argc, argv)`, so take `environ` instead of a third parameter.
	patch(join(src, 'src', 'main.c'), 'int\nmain (int argc, char **argv, char **envp)\n#endif\n{\n', 'int\nmain (int argc, char **argv)\n#endif\n{ extern char **environ; char **envp = environ;\n');
	// WASI's `d_name` is a flexible array member, so `sizeof (d->d_name)` does not compile.
	patch(join(src, 'src', 'dir.c'), 'sizeof (*d) - sizeof (d->d_name) + len', 'sizeof (*d) + len');

	const gl = join(work, 'gl');
	cpSync(join(import.meta.dirname, 'make-wasm', 'gl'), gl, { recursive: true });
	let cfg = readFileSync(join(src, 'src', 'config.h.in'), 'utf8');
	cfg = cfg.replace(/^#undef (\w+)\s*$/gm, (_, name) => name in defined ? `#define ${name} ${defined[name]}` : `/* #undef ${name} */`);
	writeFileSync(join(src, 'src', 'config.h'), cfg);

	const objDir = join(work, 'obj');
	mkdirSync(objDir);
	const sysroot = join(release, 'sysroot');
	const resourceRoot = join(release, 'resource', 'lib', 'clang');
	const resource = existsSync(resourceRoot) ? join(resourceRoot, readdirSync(resourceRoot)[0]) : join(release, 'resource');
	const preopens = { '/sysroot': sysroot, '/resource': resource, '/src': src, '/gl': gl, '/obj': objDir };
	const clangBytes = readFileSync(join(release, 'bin', 'clang.wasm'));
	const lldBytes = readFileSync(join(release, 'bin', 'lld.wasm'));
	const clang = await WebAssembly.compile(clangBytes);

	const flags = ['--target=wasm32-unknown-wasip1', '--sysroot=/sysroot', '-resource-dir=/resource', '-O1', '-w', '-fintegrated-cc1',
		'-DHAVE_CONFIG_H', '-DLIBDIR="/usr/lib"', '-DLOCALEDIR="/usr/share/locale"', '-DINCLUDEDIR="/usr/include"',
		'-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-D_WASI_EMULATED_GETPID',
		'-I/gl', '-I/src/src', '-I/src/lib', '-include', '/gl/compat.h'];
	const SKIPPED = /^(amiga|vms|vmsdir|vmsfunctions|vmsify|remote-cstms|gmk)/;
	const sources = readdirSync(join(src, 'src')).filter(f => f.endsWith('.c') && !SKIPPED.test(f)).sort().map(f => `/src/src/${f}`)
		.concat(['/src/lib/fnmatch.c', '/src/lib/glob.c', '/src/lib/getloadavg.c', '/gl/compat.c']);
	const objects = [];
	for (const file of sources) {
		const obj = `${basename(file, '.c')}.o`;
		const r = await runWasi(clang, ['clang', ...flags, '-c', file, '-o', `/obj/${obj}`], preopens, clangBytes);
		if (r.code !== 0) { throw new Error(`compiling ${file} failed (exit ${r.code}):\n${r.stderr.slice(0, 2000)}`); }
		objects.push(`/obj/${obj}`);
	}

	const lib = '/sysroot/lib/wasm32-wasip1';
	const link = await runWasi(await WebAssembly.compile(lldBytes), ['wasm-ld', `-L${lib}`, `${lib}/crt1-command.o`, ...objects, '-lc',
		'-lwasi-emulated-signal', '-lwasi-emulated-process-clocks', '-lwasi-emulated-getpid',
		'/resource/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a', '-o', '/obj/make.wasm'], preopens, lldBytes);
	if (link.code !== 0) { throw new Error(`linking make.wasm failed (exit ${link.code}):\n${link.stderr.slice(0, 3000)}`); }

	const content = Buffer.from(strip(readFileSync(join(objDir, 'make.wasm'))));
	// A fixed local-time mtime keeps the zip, and so the manifest hash, identical between runs (fflate stores local time).
	const payload = Buffer.from(zipSync({ 'make.wasm': [content, { level: 9, mtime: new Date(2000, 0, 1) }] }));
	mkdirSync(outDir, { recursive: true });
	for (const f of readdirSync(outDir)) { if (/^make\.zip$|^manifest\.json$/.test(f)) { rmSync(join(outDir, f)); } }
	writeFileSync(join(outDir, 'make.zip'), payload);
	const files = { 'make.wasm': { size: content.length, sha256: sha256(content), payloadKind: 'zip', chunks: [{ name: 'make.zip', size: payload.length, sha256: sha256(payload) }] } };
	const manifestText = JSON.stringify({ format: 1, tag, files }, null, 2);
	writeFileSync(join(outDir, 'manifest.json'), manifestText);
	const manifestSha = sha256(Buffer.from(manifestText));
	console.log(`make.wasm ${content.length} bytes -> make.zip ${payload.length} bytes; manifest.json (tag ${tag}) sha256 ${manifestSha}`);

	if (flag('--pin')) {
		const pinFile = join(repo, 'src', 'web', 'make', 'makePin.ts');
		const text = readFileSync(pinFile, 'utf8');
		const updated = text.replace(/manifestSha256: '[0-9a-f]*'/, `manifestSha256: '${manifestSha}'`).replace(/(llvm-artifacts)@[^/']+\/\w+'/, `$1@${tag}/makedist'`);
		if (updated === text && !text.includes(manifestSha)) { throw new Error(`${pinFile}: no manifestSha256 field to update`); }
		writeFileSync(pinFile, updated);
		console.log(`pinned in ${pinFile}`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
