import * as assert from 'assert';
import { PCH_HEADER_SOURCE, PCH_HEADERS, pchRetryable, selectPch, type PchSet, type PchVariant } from '../../toolchain/pch';

const variant = (std: string, optimization = '0'): PchVariant => ({ file: `pch-${std}-${optimization}.pch`, std, optimization });
const SET: PchSet = {
	defaultStd: 'gnu++17',
	variants: ['gnu++17', 'c++17', 'gnu++20', 'c++20'].flatMap(std => [variant(std), variant(std, '2')]),
};
const SOURCE = '#include <vector>\nint main() {}\n';
const skipped = (flags: string[], source: string | undefined = SOURCE, set: PchSet | null = SET) => {
	const choice = selectPch(set ?? undefined, flags, source);
	return 'skip' in choice ? choice.skip : undefined;
};
const chosen = (flags: string[], source: string | undefined = SOURCE) => {
	const choice = selectPch(SET, flags, source);
	return 'variant' in choice ? choice.variant.file : `skipped: ${choice.skip}`;
};

suite('precompiled header selection', () => {
	test('no flags use the default standard at -O0', () => {
		assert.strictEqual(chosen([]), 'pch-gnu++17-0.pch');
	});

	test('-std picks its variant, aliases included, and the last one wins', () => {
		assert.strictEqual(chosen(['-std=c++20']), 'pch-c++20-0.pch');
		assert.strictEqual(chosen(['--std=gnu++2a']), 'pch-gnu++20-0.pch');
		assert.strictEqual(chosen(['-std=c++1z']), 'pch-c++17-0.pch');
		assert.strictEqual(chosen(['-std=c++20', '-std=c++17']), 'pch-c++17-0.pch');
	});

	test('the optimization level picks its variant; -O means -O1', () => {
		assert.strictEqual(chosen(['-O2']), 'pch-gnu++17-2.pch');
		assert.strictEqual(chosen(['-O2', '-O0']), 'pch-gnu++17-0.pch');
		assert.match(chosen(['-O']), /no precompiled header for -std=gnu\+\+17 at -O1/);
		assert.match(chosen(['-Os']), /at -Os/);
	});

	test('a standard with no prebuilt variant is skipped, naming it', () => {
		assert.match(chosen(['-std=c++11']), /no precompiled header for -std=c\+\+11 at -O0/);
	});

	test('harmless flags do not matter', () => {
		assert.strictEqual(chosen(['-Wall', '-Wextra', '-g', '-I/workspace', '-fno-strict-aliasing', '-DUSE_THING', '-DLEVEL=3', '-D', 'MODE=2']), 'pch-gnu++17-0.pch');
	});

	test('a macro the headers read, or any -U, is skipped', () => {
		for (const flags of [['-DNDEBUG'], ['-D_GNU_SOURCE'], ['-D__STDC_LIMIT_MACROS'], ['-D_LIBCPP_HARDENING_MODE=1'], ['-D', 'NDEBUG'], ['-UFOO'], ['-U', 'FOO']]) {
			assert.match(skipped(flags) ?? 'used', /could change what the standard headers declare/, flags.join(' '));
		}
	});

	test('flags that rewrite the preamble are skipped', () => {
		for (const flag of ['-include', '-include-pch', '-imacros', '-undef', '-x', '-ffreestanding', '-Xclang', '-ansi', '-fmodules']) {
			assert.match(skipped([flag, 'x']) ?? 'used', /could change what the standard headers declare/, flag);
		}
	});

	test('a -D value is not mistaken for the next flag', () => {
		assert.strictEqual(chosen(['-D', 'FOO', '-std=c++20']), 'pch-c++20-0.pch');
	});

	test('a #define or #undef before the first #include is skipped; one after is fine', () => {
		assert.match(skipped([], '#define private public\n#include <vector>\n') ?? 'used', /defines a macro before its first #include/);
		assert.match(skipped([], '// header\n  #  undef NDEBUG\n#include <string>\n') ?? 'used', /defines a macro/);
		assert.strictEqual(chosen([], '#include <vector>\n#define N 3\nint main() {}\n'), 'pch-gnu++17-0.pch');
		assert.strictEqual(chosen([], '#include <vector>\r\n#define N 3\r\n'), 'pch-gnu++17-0.pch');
	});

	test('a source that includes nothing the PCH holds is skipped', () => {
		assert.match(skipped([], 'int main() {}\n') ?? 'used', /includes nothing/);
		assert.match(skipped([], '#include <cstdio>\n#include <cstdlib>\n') ?? 'used', /includes none of the precompiled headers/);
		assert.match(skipped([], '#include <stdio.h>\n') ?? 'used', /includes none/);
	});

	test('a project header may hold the heavy includes, so a quoted include counts', () => {
		assert.strictEqual(chosen([], '#include "util.h"\n'), 'pch-gnu++17-0.pch');
		assert.strictEqual(chosen([], '  # include <iostream>\n'), 'pch-gnu++17-0.pch');
	});

	test('unknown source text still allows a PCH', () => {
		assert.strictEqual(chosen([], undefined), 'pch-gnu++17-0.pch');
	});

	test('a toolchain without the pch section, or with no variants, gets none', () => {
		assert.match(skipped([], SOURCE, null) ?? 'used', /no precompiled headers/);
		assert.match(skipped([], SOURCE, { defaultStd: 'gnu++17', variants: [] }) ?? 'used', /no precompiled headers/);
	});

	test('the header source lists every header once and leaves out the hazards', () => {
		assert.strictEqual(new Set(PCH_HEADERS).size, PCH_HEADERS.length);
		assert.strictEqual(PCH_HEADER_SOURCE.split('\n').filter(l => l !== '').length, PCH_HEADERS.length);
		for (const unwanted of ['cmath', 'cassert', 'cstdio.h', 'assert.h', 'math.h']) {
			assert.ok(!PCH_HEADERS.includes(unwanted), `${unwanted} must stay out of the PCH`);
		}
	});
});

suite('precompiled header retry', () => {
	test('clang rejecting the PCH, or a clash with a name only the PCH declared, retries', () => {
		assert.ok(pchRetryable("error: OptimizationLevel differs in precompiled file '/obj/x.pch' vs. current file"));
		assert.ok(pchRetryable("fatal error: malformed or corrupted precompiled file: 'x'"));
		assert.ok(pchRetryable("a.cpp:2:5: error: redefinition of 'rand' as different kind of symbol"));
		assert.ok(pchRetryable("a.cpp:3:9: error: reference to 'size' is ambiguous"));
		assert.ok(pchRetryable('a.cpp:3:9: error: conflicting types for \'f\''));
	});

	test('ordinary errors do not', () => {
		assert.ok(!pchRetryable("a.cpp:2:1: error: expected ';' after expression"));
		assert.ok(!pchRetryable("a.cpp:1:10: fatal error: 'missing.h' file not found"));
		assert.ok(!pchRetryable("a.cpp:4:3: error: use of undeclared identifier 'x'"));
	});
});
