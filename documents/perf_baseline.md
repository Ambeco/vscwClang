# Performance baseline (2026-10-31)

Compile and link under Node WASI with the extension's real configuration: threaded `clang-threads.wasm`/`lld-threads.wasm` (what the dist ships as `clang.wasm`/`lld.wasm`; the `wasi.4-dev` release matches the dist manifest hash), threads slice, default flags, gnu++17 PCH on and off. Median of 3 (Eigen: 2), one unit at a time, Dropbox stopped, 12 cores. Reproduce: set `VSCWCLANG_ARTIFACTS` to `llvm-project/release/llvmorg-24.0.0-git-wasi.4-dev` (the default lookup picks `v0.0.0-dev`, whose C++ flags do not work) and run `node scripts/perf-bench.mjs <C:/projects dir> <names> [--only re] [--link] [--out f]`. The sysroot and PCH come from `llvm-artifacts/dist`, extracted to `C:\Users\mooin\vsclang-bench-cache`.

| Unit | PCH | no PCH |
|---|---|---|
| Lua, 34 C files | - | 142-405 ms each (median ~215), link 196 ms |
| sqlite3.c / shell.c | - | 5.9 s / 1.7 s, link 179 ms |
| fmt format.cc / os.cc | 2.1 / 0.8 s | 2.9 / 1.3 s |
| fmt gmock-gtest-all.cc | 6.3 s | 8.4 s |
| fmt core-test.cc / format-test.cc | 8.9 / 14.8 s | 11.7 / 15.7 s |
| fmt link (8 objects) | 338 ms | |
| Catch2 catch_session / Matchers.tests | 2.4 / 3.5 s | 3.9 / 4.5 s |
| Catch2 small units (catch_message_info, Approx.tests) | 0.4 / 1.1 s | 1.0 / 2.3 s |
| json unit.cpp / unit-conversions1 / unit-json_pointer | 4.5 / 8.7 / 14.7 s | 6.6 / 9.8 / 16.1 s |
| Eigen demo / basicstuff / lu | 21.9 / 30.6 / 38.2 s (re-run; first run 51.5) | 22.0 / 29.3 / 35.6 s |

Findings
- Compile dominates; every link is under 0.35 s. Single-file edit cost is the compile of that file: ~1-15 s for typical C++, 20-50 s for Eigen tests.
- PCH helps small and medium C++ files by 10-60%. On Eigen it is neutral to slightly worse (`lu.cpp` 38.2 vs 35.6 s, ~7%). The 14 s gap in the first run was noise: PCH runs show occasional outliers (one 53.6 s run against a 37.6 s minimum), which a 2-repeat median hides; use 3+ repeats. `-ftime-report` on `lu.cpp` (Node): about 18% machine code generation, 15% IR generation, the remaining ~65% is parsing/template instantiation in the frontend, so Eigen is bound by Sema, not by PCH loading.
- The earlier survey numbers (compat_survey.md) used single-threaded tools without PCH; those fmt/Catch2/json runs hit a different toolchain and are not comparable.
- Variance: first run of a unit is often the max (gmock-gtest-all.cc no-PCH max 25.9 s once); use medians.

## Link with many objects
Catch2 library, 108 objects (PCH on, one run): per-unit compile median 0.83 s, p90 1.8 s, max 4.3 s, total 113 s; link 851 ms, 4.8 MB. Link stays under 1 s, so incremental builds are compile-bound.

## Debug builds (`-O0 -g`, trace-pc-guard coverage, debug stub linked)
Compile is 2-5x release: sqlite3.c 28.9 s (release 5.9), shell.c 5.0 s (1.7), fmt core-test.cc 19.3 s with PCH (8.9), gmock-gtest-all.cc 14.6 s (6.3), format.cc 4.4 s (2.1). Link of 7 fmt objects 375 ms, 11 MB (6 MB of it `.debug_*`). Debugger launch analysis on that program: `parseModule` 9 ms, `scanProgram` 86 ms, `parseLineTable` 58 ms (156k rows); sqlite3.c alone: `parseLineTable` 103 ms (209k rows). All cheap next to the compile.
- Bug: `scanProgram` throws `hook call at wasm offset 0x38a32 has an unrecognized guard-address sequence (previous opcodes: 0x41, 0x21, 0x20)` on a debug build of SQLite (sqlite3.c + shell.c), so F5 on it would fail at launch.

## clangd (cold, `clangd --check`, Node WASI)
Single-threaded clangd.wasm from the fork (`build-single-threaded`), `-background-index=false -check-locations=false`, one file per process, so every figure is a cold preamble. AST time is the first parse of the main file after the preamble.

| File | Preamble (size) | AST |
|---|---|---|
| Lua lstring.c / lvm.c | 0.21 / 0.29 s | 0.13 / 0.39 s |
| SQLite shell.c | 0.05 s | 1.26 s |
| fmt format.cc / core-test.cc | 2.7 / 4.2 s (9 / 17 MB) | 0.08 / 0.84 s |
| Catch2 catch_session.cpp | 3.3 s (12 MB) | 0.25 s |
| json unit.cpp | 3.4 s (13 MB) | 0.08 s |
| Eigen basicstuff.cpp | 5.6 s (20 MB) | 4.8 s |

- Preamble dominates for C++ with standard headers (3-6 s here; the browser's ~14 s first preamble in remaining_work is the same work under threads and the extension host). After it, per-edit AST rebuilds are 0.1-0.8 s except template-heavy Eigen (~5 s).
- Without `-check-locations=false`, `--check` runs a completion/hover probe at every token and a 1,900-line C file took minutes; do not drop the flag.
- The shipped threaded `clangd.wasm` (dist `clangd.zip`) never exits `--check` under `runWasi` (even for a 100-line C file and with `-background-index=false`); unexplained, so these figures use the single-threaded build.

Not measured yet: background-index time and memory on a large project (needs a live vscode.dev pass or an LSP-driven harness with the threaded build), program run startup, and the debug launch-to-breakpoint and step latency in the browser.
