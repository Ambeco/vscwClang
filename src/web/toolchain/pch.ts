/**
 * Prebuilt libc++ precompiled header (PCH): which one a compile can use, and when to fall back.
 *
 * `scripts/make-toolchain-dist.mjs` builds one PCH per C++ standard with the shipped `clang.wasm`, from the
 * header list below, and lists them in `compile-flags.json` (`pch`). A compile passes `-include-pch` only when
 * `selectPch` says the PCH would behave as the plain includes would; clang itself rejects most mismatches
 * (`-std`, `-O`, `-fno-exceptions`, ...) with an error naming the PCH, but it silently accepts a `-D`/`-U`
 * that headers already consumed, a `#define` before the first `#include`, and global names the PCH's C headers
 * declare. `selectPch` screens the first two; `pchRetryable` spots the rest in the compile's errors, and the
 * build then compiles again without the PCH.
 */

/** Libc++ headers the PCH preloads. No `<cmath>` or `<cassert>`: C names such as `y1`, and `NDEBUG`, must stay the user's. */
export const PCH_HEADERS = [
	'algorithm', 'array', 'atomic', 'bitset', 'condition_variable', 'deque', 'fstream', 'functional', 'future', 'iomanip', 'iostream', 'list', 'map', 'memory', 'mutex', 'numeric',
	'optional', 'queue', 'set', 'sstream', 'stack', 'string', 'string_view', 'thread', 'tuple', 'unordered_map', 'unordered_set', 'utility',
	'variant', 'vector',
];

/** Where the PCH's header lives in the sysroot: a PCH records its source header and fails to load without it. */
export const PCH_HEADER_GUEST_PATH = '/sysroot/vscwclang/pch.h';

/** Source of `PCH_HEADER_GUEST_PATH`. */
export const PCH_HEADER_SOURCE = PCH_HEADERS.map(h => `#include <${h}>`).join('\n') + '\n';

export interface PchVariant {
	/** Manifest file name, e.g. `pch-gnupp17.pch`. */
	file: string;
	/** Canonical `-std` value the PCH was built with, e.g. `gnu++17`. */
	std: string;
	/** `-O` level the PCH was built with: `0` (none or `-O0`), `1`, `2`, `3`, `s`, ... */
	optimization: string;
}

/** The `pch` section of `compile-flags.json` for one target slice. */
export interface PchSet {
	/** What clang uses when the user passes no `-std`. */
	defaultStd: string;
	variants: PchVariant[];
}

export type PchChoice = { variant: PchVariant } | { skip: string };

const STD_ALIASES: Record<string, string> = {
	'c++1z': 'c++17', 'gnu++1z': 'gnu++17', 'c++2a': 'c++20', 'gnu++2a': 'gnu++20',
	'c++2b': 'c++23', 'gnu++2b': 'gnu++23', 'c++2c': 'c++26', 'gnu++2c': 'gnu++26',
};

/** Flags that change what headers declare without clang noticing the mismatch. */
const SILENT_HAZARDS = new Set(['-undef', '-x', '-ffreestanding', '-Xclang', '-Xpreprocessor', '-ansi', '-trigraphs']);

/** `-D` names that headers read: reserved names (`_GNU_SOURCE`, `_LIBCPP_*`, `__STDC_*`) and `NDEBUG`. */
const hazardousMacro = (name: string) => name.startsWith('_') || name === 'NDEBUG';

/**
 * Picks the PCH for one C++ source, or says why not.
 *
 * `compileFlags` are the user-supplied compile flags (settings, language and per-source flags); the toolchain's
 * own flags are what the PCH was built with. `source` is the source text, if known: a PCH only pays off when the
 * file includes something it holds, and a `#define` before the first `#include` would not reach the PCH's headers.
 */
export function selectPch(set: PchSet | undefined, compileFlags: readonly string[], source: string | undefined): PchChoice {
	if (!set || set.variants.length === 0) { return { skip: 'this toolchain has no precompiled headers' }; }
	let std = set.defaultStd;
	let optimization = '0';
	for (let i = 0; i < compileFlags.length; i++) {
		const f = compileFlags[i];
		const stdFlag = /^--?std=(.+)$/.exec(f);
		if (stdFlag) { std = STD_ALIASES[stdFlag[1]] ?? stdFlag[1]; continue; }
		const opt = /^-O(.*)$/.exec(f);
		if (opt) { optimization = opt[1] === '' ? '1' : opt[1]; continue; }
		if (f.startsWith('-U') || (f.startsWith('-D') && hazardousMacro((f.length > 2 ? f.slice(2) : compileFlags[i + 1] ?? '').split('=')[0]))) {
			return { skip: `${f} could change what the standard headers declare` };
		}
		if (f === '-D' || f === '-U') { i++; continue; }
		if (SILENT_HAZARDS.has(f) || f.startsWith('-fmodules') || f.startsWith('-include') || f.startsWith('-imacros')) {
			return { skip: `${f} could change what the standard headers declare` };
		}
	}
	const variant = set.variants.find(v => v.std === std && v.optimization === optimization);
	if (!variant) { return { skip: `no precompiled header for -std=${std} at -O${optimization}` }; }
	if (source !== undefined) {
		const lines = source.split(/\r?\n/);
		const firstInclude = lines.findIndex(l => /^\s*#\s*include\b/.test(l));
		if (firstInclude < 0) { return { skip: 'the source includes nothing' }; }
		if (lines.slice(0, firstInclude).some(l => /^\s*#\s*(define|undef)\b/.test(l))) { return { skip: 'the source defines a macro before its first #include' }; }
		const usesPch = lines.some(l => {
			const m = /^\s*#\s*include\s*(?:<([^>]+)>|"[^"]+")/.exec(l);
			return m !== null && (m[1] === undefined || PCH_HEADERS.includes(m[1]));
		});
		if (!usesPch) { return { skip: 'the source includes none of the precompiled headers' }; }
	}
	return { variant };
}

/**
 * Whether a failed compile that used a PCH should be repeated without it.
 *
 * True for clang rejecting the PCH itself, and for name clashes, which the PCH's C headers cause when the user
 * declares a global they would not have seen otherwise (`index`, `y1`). A genuine clash in the user's code
 * fails again without the PCH, and that second report is the one shown.
 */
export function pchRetryable(stderr: string): boolean {
	return /precompiled (file|header)|redefinition of|different kind of symbol|is ambiguous|conflicting (types|declaration)|previous (declaration|definition)/.test(stderr);
}
