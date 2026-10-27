# Compatibility survey (2026-10-27)

Can real, largish portable projects be built and tested with the shipped toolchain? Independent of performance; baselines for later work.

Method: `scripts/compat-survey.mjs` + `scripts/compat-projects.mjs` run the repo's `clang.wasm`/`lld.wasm` under Node WASI with the extension's own command lines (`toolchain.ts` `build()`: `compile-flags.json` slice, no `-O`, default `gnu++17`, `-c -o -`, then `wasm-ld`), one worker per tool call sharing one compiled Module, then run the linked `.wasm`. Flags are checked with `checkUserFlags`. Sources live in `C:\Users\mooin\vsclang-compat` (outside the repo). Node WASI timings track the browser closely (notes.md 2026-10-06), but this is a proxy.

Timing caveat: sweeps ran 4 TUs in parallel on 12 cores, which inflates per-file times by up to ~1.5x (`core-test.cc` 16.2 s at `--j 4`, 12.1 s alone). "Alone" figures are from `--j 1` samples. No `-O` anywhere (the extension's release default).

## Results

| Project (version) | TUs | Compiled | Compile total (j=4) / median / max | Link | Tests run |
|---|---|---|---|---|---|
| Lua 5.5.1 | 34 | 34 | 4.7 s / ~0.1 s / 0.6 s | 0.16 s, 0.8 MB | 5 scripts pass (pcall via sjlj, coroutines, io); `fib(30)` 0.27 s |
| SQLite 3.54.1 amalgamation | 2 | 2 | `sqlite3.c` 9.2 s alone (8.9 s at j=4), `shell.c` ~1.6 s | 0.16 s, 2.2 MB | 3 SQL scripts pass (file db in `/tmp`, JSON, window fn) |
| Catch2 (master 2026-10) | 166 (lib 108 + SelfTest 59, minus `Sleep.tests.cpp`) | 166 | 316 s / 1.8 s / 6.8 s | 0.73 s, 12.3 MB | SelfTest default filter passes, 0.5 s |
| fmt (master 2026-10) | 27 | 23 | 204 s / 5.8 s / 22 s | 0.1-0.25 s, 2.5-4.4 MB each | core, ostream, printf, ranges, args pass (22-91 ms); chrono: 38/40 pass |
| nlohmann/json (master 2026-10) | 118 `unit*.cpp` | 116 | 2273 s / 15 s / 110 s (`unit-json_view_*`) | 0.05-0.33 s, 1.6-22 MB | unicode1, conversions, json_pointer (11 s, 206k assertions) pass; regression1 fails (test data absent); class_parser passes with an 8 MiB stack |
| Eigen (master 2026-10), 11 tests + demo, each `EIGEN_TEST_PART_1` | 12 | 12 | 614 s / 53 s / 98 s (`cholesky`) | 0.1-0.28 s, 2.5-14 MB | 12/12 pass once linked with an 8 MiB stack (12-500 ms each) |

Whole-suite builds: json = 118 TUs, ~38 min sequential-equivalent; Catch2 ~5 min; Eigen tests are the heaviest per file (22-37 s for `basicstuff`/`geo_transformations` alone). `PART_ALL` Eigen tests (every sub-test in one TU) die with `LLVM ERROR: out of memory` after ~150-190 s (2 GiB wasm32 cap) — fundamental until memory64 / a bigger heap, and a real limit.

## Findings by bucket

Blocker buckets: (a) works with flags the extension already accepts; (b) needs a project source patch or stub; (c) needs an extension/toolchain change; (d) fundamental to wasm/web.

### (a) Flags/defines only (all pass `checkUserFlags`)
- `-D_WASI_EMULATED_SIGNAL` + `-lwasi-emulated-signal` for anything including `<signal.h>` (Lua, SQLite shell, Catch2, fmt/gtest, doctest). Also `_WASI_EMULATED_{MMAN,GETPID,PROCESS_CLOCKS}` for SQLite/Lua. Without them: `error: "wasm lacks signal support..."`. Suggest: a "wasm porting hints" doc/quick-fix, or enabling these emulations by default (they are small and harmless).
- Lua: `-mllvm -wasm-enable-sjlj` + `-lsetjmp` makes `setjmp/longjmp` (error handling) work. Without: `undefined symbol: longjmp`. Worth defaulting for C sources (effort: small, toolchain flag + sysroot already has `libsetjmp.a`).
- SQLite: `-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_NOHAVE_SYSTEM`.
- Catch2: `-DCATCH_CONFIG_NO_POSIX_SIGNALS` (else `stack_t` undeclared); needs the CMake-generated `catch_user_config.hpp` (we copied one; a user needs a CMake step or a hand-written file).
- fmt: `-DGTEST_HAS_PTHREAD=0`, `-DFMT_HEADER_ONLY` for header-only tests.
- Eigen: link `-Wl,-z,stack-size=8388608`. The default wasm stack is too small: `cholesky` and `sparse_product` trap with `memory access out of bounds` and json `class_parser` the same, with no hint of "stack overflow". (c) candidate: raise the default stack (1 MiB+) or detect and say so in the trap message.

### (b) Source patch or stub
- Lua: `tmpnam`/`L_tmpnam` missing (override via `-Dlua_tmpnam(b,e)=(e=1)`), `tmpfile` and `system` are link errors (stub file, ~2 lines). Effort: minutes.
- doctest (json tests): `doctest.h` forces `DOCTEST_CONFIG_NO_EXCEPTIONS` when `defined(__wasi__)`, ignoring `__cpp_exceptions`; `CHECK_THROWS*` then fails with a static_assert. The documented `DOCTEST_CONFIG_NO_EXCEPTIONS_BUT_WITH_ALL_ASSERTS` workaround compiles but silently skips NOTHROW bodies (hundreds of false failures); a one-token patch to `doctest.h` fixed it. Likely hits every doctest user. Upstream-able; effort: minutes per project.
- fmt gtest: `mkstemp` undeclared (we used `-Dmkstemp(t)=(-1)`); json `unit-json_view.cpp`: incomplete `FILE` (`_IO_FILE`) — needs `#include <cstdio>` (upstream bug exposed by libc++); `unit-no-macro-leak.cpp` needs a CMake-generated `.inc`.

### (c) Extension/toolchain changes
- **CMake `compile_commands.json` target picker cannot build a test target.** Real CMake output for fmt (52 entries, 28 targets): picking `format-test` yields only `test/format-test.cc`; the library (`fmt`: `src/format.cc`, `src/os.cc`), `gtest` and `test-main` are separate targets, so it will not link. "All targets" links every `main`. Entries duplicated across targets (`test-main.cc`, `os.cc`) are reported as skipped. Needs target-dependency awareness (CMake File API `codemodel-v2`, or `link.txt`/`build.make` parsing) so a target pulls in its link dependencies. Effort: medium. (Tested with `planFromCompileCommands` on a real Makefile-generator database; absolute paths and the in-tree `build/` directory were mapped correctly.)
- **No threads in libc++**: `std::thread`, `std::this_thread`, `std::mutex` are absent. Blocks Catch2 `Sleep.tests.cpp`, fmt `std.h` (`std::thread::id` formatter: compile-test, std-test, xchar-test), fmt `format-test` (`std::mutex`). Each blocks a whole test executable. Resolved by the planned multithreading work (`wasm32-wasip1-threads`); until then, source-level workarounds only.
- Uncaught C++ exceptions in tests that do not go through the `__main_void` shim print `WebAssembly.Exception` in my harness; the extension's shim handles `main`, so this is a harness gap, not a product gap.
- Missing `mkstemp`, `tmpfile`, `system`, `popen` in wasi-libc are real library gaps, not extension bugs.

### (d) Fundamental
- 2 GiB wasm32 memory cap: Eigen `PART_ALL` TUs run out of memory in clang (`LLVM ERROR: out of memory` after ~3 min). Splitting tests (`PART_1..N`) is the only fix.
- No processes/signals: `system`, `popen`, fatal-signal handlers (Catch2/doctest crash reporting), `fork` death tests (gtest).
- Single-threaded: all timings are single-thread; json's full suite at ~38 min and Eigen's per-file 20-100 s are the baselines to beat with concurrency/PCH.

### Test-run discrepancies still to explain
- fmt `chrono-test`: `weekday` and `year_month_day` fail (38/40 pass). Not investigated; suspect locale/timezone (no `/etc`, no `localtime` data).
- json `regression1`: fails on missing `json_test_data` (data issue, not compiler).

## Timing baselines (single TU, `--j 1`, no `-O`)
`format.cc` 3.9 s; `catch_session.cpp` 4.1 s; `Matchers.tests.cpp` 5.0 s; `core-test.cc` 12.1 s; Eigen `basicstuff` 22 s, `geo_transformations` 37 s; `sqlite3.c` (9 MB) 9.2 s; Lua per file <0.6 s. Link 0.05-0.3 s (0.7 s for Catch2's 12 MB). Run phase 10 ms - 2 s (json_pointer 11 s for 206k assertions). Compile dominates everything; link and run are noise. Reproduce: `node scripts/compat-survey.mjs <dir with clones> lua,sqlite,catch2,fmt,json,eigen [--j 4] [--only regex]` (set `NODE_NO_WARNINGS=1`, `MSYS_NO_PATHCONV=1` in Git Bash; paths in Windows `C:/` form).
