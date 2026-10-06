/**
 * Validates user-supplied compiler flags against the toolchain's fixed target and sandbox.
 *
 * Returns one human-readable problem per rejected flag, each with a "did you mean" suggestion;
 * an empty array means the flags are acceptable.
 */
export function checkUserFlags(flags: readonly string[]): string[] {
	const problems: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const f = flags[i];
		const next = flags[i + 1];
		const reject = (why: string, suggestion: string) => problems.push(`Flag '${f}' is not allowed: ${why}. Did you mean ${suggestion}?`);
		if (f.startsWith('-fplugin')) {
			reject('compiler plugins cannot be loaded in the browser', 'to remove it');
		} else if (f.startsWith('-fuse-ld')) {
			reject('the linker is always the bundled wasm-ld', 'to remove it');
		} else if (f === '-B' || f.startsWith('-B')) {
			reject('there is no host toolchain search path', 'to remove it (headers and libraries come from the bundled sysroot)');
		} else if (f.startsWith('--sysroot') || f === '-isysroot' || f.startsWith('-resource-dir') || f === '-nostdinc' || f === '-nostdlibinc') {
			reject('the sysroot and resource dir are fixed by the toolchain', `'-I<dir>' for extra headers inside the workspace`);
		} else if (f.startsWith('--target') || f === '-target' || f.startsWith('-march=') || f.startsWith('-mcpu=')) {
			reject('output is always wasm32-wasip1', `to select threads via the 'threads' setting instead`);
		} else if (f === '-o' || f === '-c' || f === '-S' || f === '-E') {
			reject('the build command controls output and compile/link stages', `the build output setting instead`);
		} else if (/^-(I|isystem|iquote|L)/.test(f)) {
			const path = f.replace(/^-(I|isystem|iquote|L)/, '') || next;
			if (path !== undefined && isHostPath(path)) {
				reject(`'${path}' is outside the workspace and sysroot`, `a workspace-relative path such as '-I${path.replace(/^.*[\\/]/, '')}'`);
			}
			if (!f.replace(/^-(I|isystem|iquote|L)/, '')) { i++; }
		}
	}
	return problems;
}

function isHostPath(path: string): boolean {
	if (path.startsWith('/workspace/') || path === '/workspace' || path.startsWith('/sysroot/') || path === '/sysroot') { return false; }
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes('..');
}

/**
 * Splits user flags into those for `clang -c` and those for `wasm-ld`.
 *
 * `-l`, `-L` (attached or separated), and `-Wl,a,b` (becomes `a`, `b`) are link-only; relative `-L` dirs
 * are resolved under `guestWorkspace` since wasm-ld's cwd is not the workspace. Everything else is a compile flag.
 */
export function splitFlags(flags: readonly string[], guestWorkspace: string): { compile: string[]; link: string[] } {
	const compile: string[] = [];
	const link: string[] = [];
	const absolute = (dir: string) => /^(\/|[A-Za-z]:[\/])/.test(dir) ? dir : `${guestWorkspace}/${dir.replace(/^\.\//, '')}`;
	for (let i = 0; i < flags.length; i++) {
		const f = flags[i];
		if (f === '-l' || f === '-L') {
			const value = flags[++i];
			if (value === undefined) { throw new Error(`vscwClang: flag '${f}' needs an argument. Did you mean '${f}<name>'?`); }
			link.push(f === '-L' ? `-L${absolute(value)}` : `-l${value}`);
		} else if (f.startsWith('-L')) {
			link.push(`-L${absolute(f.slice(2))}`);
		} else if (f.startsWith('-l')) {
			link.push(f);
		} else if (f.startsWith('-Wl,')) {
			link.push(...f.slice(4).split(',').filter(a => a !== ''));
		} else {
			compile.push(f);
		}
	}
	return { compile, link };
}
