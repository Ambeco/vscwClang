export const SINGLE_SLICE = 'wasm32-wasip1';
export const THREADS_SLICE = 'wasm32-wasip1-threads';

/**
 * @helper Which toolchain slice a program is built for.
 *
 * The threads slice is the default when the toolchain ships it, because libc++ without it has no `<thread>` or
 * `<mutex>` and the libraries that merely include them (fmt, Catch2) would not compile. `-pthread` or `-lpthread`
 * in any flag list selects it even when the setting is off; a toolchain without it fails loudly then.
 */
export function chooseSlice(available: Iterable<string>, threadsEnabled: boolean, flagLists: readonly (readonly string[])[]): string {
	const slices = new Set(available);
	const asked = flagLists.some(flags => flags.some((f, i) => f === '-pthread' || f === '-lpthread' || (f === '-l' && flags[i + 1] === 'pthread')));
	if (!asked && (!threadsEnabled || !slices.has(THREADS_SLICE))) { return SINGLE_SLICE; }
	if (!slices.has(THREADS_SLICE)) {
		throw new Error(`vscwClang: -pthread needs the threaded standard library, but this toolchain only has ${[...slices].join(', ') || 'no slices'}. Did you mean to update the toolchain, or to remove -pthread?`);
	}
	return THREADS_SLICE;
}
