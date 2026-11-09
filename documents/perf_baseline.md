# Performance baseline (2026-10-31)

Compile and link under Node WASI with the extension's real configuration: threaded `clang.wasm`/`lld.wasm` ( the `wasi.4-dev` release matches the dist manifest hash), threads slice, default flags, gnu++17 PCH on and off. Median of 3 (Eigen: 2), one unit at a time, Dropbox stopped, 12 cores. Reproduce: set `VSCWCLANG_ARTIFACTS` to `llvm-project/release/llvmorg-24.0.0-git-wasi.4-dev` (the default lookup picks `v0.0.0-dev`, whose C++ flags do not work) and run `node scripts/perf-bench.mjs <C:/projects dir> <names> [--only re] [--link] [--out f]`. The sysroot and PCH come from `llvm-artifacts/dist`, extracted to `C:\Users\mooin\vsclang-bench-cache`.

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
- `scanProgram` used to throw on SQLite debug builds (clang keeps the guard address in `-O0` locals: `i32.const A; local.set X; i32.const B; local.set Y; local.get X; local.get Y; i32.add; local.set L; local.get L; call hook`); fixed, it now takes 252 ms there.

## clangd (cold, `clangd --check`, Node WASI)
Single-threaded clangd.wasm (an earlier build, since removed), `-background-index=false -check-locations=false`, one file per process, so every figure is a cold preamble. AST time is the first parse of the main file after the preamble.

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
- The threaded `clangd.wasm` used to hang in `--check` under `runWasi`: `clang-wasi.mjs` started every thread Worker as a second main instance (its workerData inherited `clangWasi`), so each spawn recursed forever. Fixed (regression test in `clangWasiThreads.node.test.ts`); the figures below are from the single-threaded build, the PGO section further down from the threaded one.

Not measured yet: background-index time and memory on a large project (needs a live vscode.dev pass or an LSP-driven harness with the threaded build), program run startup, and the debug launch-to-breakpoint and step latency in the browser.

## Compile-time experiments (2026-10-31)
Per-file compile is single-threaded inside clang and split roughly half Sema/parse (`-fsyntax-only` takes 6.4 of 12.4 s on fmt `core-test.cc`) and half IR/machine code at `-O0`.
- Parallel units (Catch2 library, 108 files, PCH): 113 s at `--j 1`, 40 s at 4 (2.8x), 33 s at 8 (3.4x). The extension's cap of 4 already gets most of it; raising it buys ~18% on 8+ core machines at several hundred MB per compile.
- A project-level PCH chained on the libc++ one (gmock headers, 7 MB, built in 3 s) saves only ~15% on `core-test.cc` (12.7 to 10.8 s): the time is the test bodies' template instantiation, not header parsing. Not worth an automatic project PCH.
- No effect: `-w`, `-mllvm -fast-isel`. `-fno-builtin` is rejected with the PCH (it records the setting).
- Process floor: ~140 ms per tool invocation (instantiate plus run of an empty C file), which is a third of Lua's 34 small files.
- Toolchain build: `clang.wasm` is built `MinSizeRel` (`-Os`, `build.bat`). `wasm-opt -O3` (binaryen 132, 30 min for the 66 MB clang) shrinks it to 52 MB; `--all-features` output is not loadable by Node 24 (`unknown import kind 0x7e`), so use an explicit feature list.
- Result with `wasm-opt -O3 --enable-threads --enable-bulk-memory --enable-exception-handling --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types --enable-tail-call` (23.6 min, JS binaryen 132): `clang-threads.wasm` 66.3 to 52.5 MB, loads in Node 24, same Lua link size (863382 bytes), compile 6-7% faster (fmt `core-test.cc` 9.2-9.3 to 8.6-8.7 s, `format.cc` 2.3-2.4 to 2.2 s, two A/B rounds). Modest but free.
- Same pass on the other shipped tools (explicit features, JS binaryen; durations 1.6-20 min): `llvm-ar` 4.4 to 3.6 MB, `lld-threads` 30.3 to 23.5 MB (20 min), `clangd` 34.5 to 27.6 MB (8.5 min), `lldb-wasm-reactor` 59.9 to 48.8 MB (17 min), about 20% each. Against a toolchain folder holding all five optimized files: `npm run test-node` 346 passing, 0 failing (reactor tests included, via a temporary `llvm-artifacts/bin` copy); `clangd --version` runs; the fmt subset links to the same 6264187 bytes; the browser suite has not been run. Compile wall time of an 8-file fmt subset at `--j 4` is unchanged (17.1 to 17.0 s) because `format-test.cc` is the long pole. Outputs are in `C:/Users/mooin/vsclang-bench-cache/opt` and `opt-tc`; the script is `optall.sh` next to them.

## Debug builds with the PGO toolchain (v24.0.10, 2026-11-02)
`-O0 -g` + trace-pc-guard coverage, `--pch on --j 1`, one run each, raw tools (`-Os` release build vs `-O2` + ThinLTO + PGO): Lua 10.3 to 10.0 s, SQLite (sqlite3.c, shell.c, link) 23.4 to 21.6 s, fmt subset (8 files + link) 58.8 to 51.9 s; total 92.5 to 82.5 s (-10.9%). That is half the -23.5% the release-mode corpus got: the profile was trained on release-mode compiles, so the `-O0 -g` + coverage-instrumentation paths (debug info, SanitizerCoverage, the -O0 pipeline) are unprofiled. Training the profile with `--debug` as well is the likely fix. Debug launch analysis is unchanged (fmt: parseModule 52 ms, scanProgram 135 ms, parseLineTable 67 ms).

## clangd with the PGO toolchain
Browser-suite A/B, old v24.0.8 dist vs v24.0.10, one run each: first diagnostic 852 vs 1206 ms, hover/go-to-definition 4198 vs 4638 ms, background indexing 4219/4318 vs 4873/4902 ms. Startup-bound, so the larger `clangd.wasm` (50 MB vs 34 MB) costs about 10-15%. The old clangd crashed ("memory access out of bounds") on the large-completion test; the new one passes (8.3 s). Warm parse speed, `perf-clangd.mjs` best of 3 (cold preamble + AST per process, threaded clangd, `-sync` not needed any more), old v24.0.8 clangd vs PGO v24.0.10: Lua lvm.c 758 to 648 ms (-15%), fmt format.cc 1919 to 1619 (-16%), core-test.cc 3785 to 3020 (-20%), json unit-conversions1 4750 to 3779 (-20%), Eigen basicstuff 7371 to 5597 (-24%). The startup cost above is real but small next to that once a file is edited.

Config knobs (`PERF_CLANGD_CONFIG` writes `config.yaml` read through `XDG_CONFIG_HOME=/cfg`): `InlayHints.Enabled: No` plus `Diagnostics.UnusedIncludes/MissingIncludes: None` changes lvm 666 to 640, format 1620 to 1597, core-test 3050 to 2969, json 3777 to 3704, Eigen 5596 to 5585 ms: 0-4%, near the noise, not worth a setting. wasm-opt -O3 on the PGO clangd is neutral (666/1620/3050/3777/5596 vs 702/1597/2999/3697/5499 ms) and saves 6 MB (44 vs 50), unlike clang where it hurts. `--check` spends 9 s of shell.c's 10.8 s in semantic highlighting (40k lines, about 0.23 ms per line) and 0.5 s in inlay hints; both are requested by the editor on every edit of an open file, so the real cost for large files is semantic tokens, not parsing.
## clangd background indexing (PGO v24.0.10, `scripts/perf-clangd-index.mjs`, 2026-11-02)
The harness runs the threaded clangd as an LSP server (stdin piped through a child process), feeds it the sources the way the extension does (`didChangeConfiguration` `compilationDatabaseChanges`, shards under `XDG_CACHE_HOME=/cache`) and times until every unit has a shard. `/workspace/build` and `/workspace/.cache` are shadowed so a project's own `compile_commands.json` is ignored and nothing is written into it. 12-core box, idle.

| Project (units) | -j 1 | -j 2 | -j 4 | -j 8 |
|---|---|---|---|---|
| Lua (33 C files) | 3.5 s | 2.3 s | 1.9 s | hung at 32/33 |
| Catch2 (166 files) | 202 s | 117 s | 79 s | 68 s |
| fmt (27 files) | | | 29 s | |

Scaling is 1.7x at `-j 2`, 2.5x at `-j 4`, 3.0x at `-j 8` (Catch2), so the extension's cap of 4 gets most of it; 8 adds about 14% more.
- Occasionally a worker thread traps ("memory access out of bounds") under the Node harness and its file is never indexed (Lua `-j 8` never finished; one or two traps also appear at `-j 4`, with the old clangd too). Not seen in the browser suite; unexplained.
- libc++ PCH: clangd silently drops `-include-pch` (a nonexistent PCH path produces no error and no speed change: fmt 27.2 s plain vs 27.9 s with the PCH), so it cannot speed up indexing.
- `-fmodules -fimplicit-module-maps -fmodules-cache-path=...`: the file indexes ("Failed to compile ..., index may be incomplete"), with far fewer symbols (os.cc 1785 vs 3852) and more time (5.5 s vs 1.2 s for one file, including building the std module). Not viable.

## clangd first index in the browser (vscode.dev, v24.0.13 pinned, 2026-11-08)
Cold `clangd-cache` (IndexedDB keys under `globalStorage/<ext>/clangd-cache/` deleted, folder reseeded in OPFS, `compile_commands.json` with the same units and flags as `perf-clangd-index.mjs`, 12 cores, one run each). Time is the "indexing N/M" status-bar item, polled every 1 s; it starts about 4-8 s after opening a source file (clangd start-up).
- Lua (33 units): about 4 s (Node `-j 4`: 1.9 s). fmt (27 units + gtest): about 55 s (Node: 29 s). So the browser is about 2x the Node harness.
- Chrome total working set (all processes, includes vscode.dev itself) went 2.1 to 3.7 GB during the fmt run; per-wasm-memory is not measured.
- A `compile_commands.json` without the sysroot/`--target` flags indexes in seconds but is invalid: every `#include <vector>` is "file not found" and the log says "Failed to compile ..., index may be incomplete". The extension does not add toolchain flags to database entries (CMake output for this toolchain carries them). Validate a run by counting `file not found` in the `vscwclang` output log (expect 0).
- Log also shows `Failed to auto-detect resource directory` and, in the first run, `config.yaml:2:0: Config should be a dictionary` (not yet investigated; the second run had no config error).

## Incremental build in the browser (vscode.dev, v24.0.13, Lua 34 files, 12 cores, 2026-11-09)
Command click to completion (`build.log` mtime), `vscwClang: Build C++`, release, threads slice, objects in the Cache API. The `vscwclang` output now ends each build with `build phases (ms): ensure, sysroot, shims, sources, link, total`; "sources" covers cache validation plus every compile.
| Scenario | Before (header reads per source) | After (reads memoized per build, headers checked in parallel) |
|---|---|---|
| First build of a page session (cold objects reused, page reloaded) | 21.0 s (shims 9.4, sources 10.6, link 0.9) | 20.8 s (same) |
| Nothing changed | 1.6 s | 0.6 s |
| Edit one leaf .c (1 compile + 33 reused, link 0.35 s) | 2.8-3.5 s | 1.9-2.4 s |
| Edit `lobject.h` (19 units recompile; objects unchanged, link skipped) | 5.1-5.4 s | 4.2-4.6 s |
- Per-file compile in the browser is 0.5-1.0 s (Node: 0.14-0.4 s), about 2x Node, like clangd indexing.
- Comment-only edits recompile one unit but write no new `a.out.wasm` (object bytes identical, link skipped); `build.log` is the completion signal, not the wasm mtime.
- The two palette-driven timings include about 2 s of harness typing; the numbers above exclude it (timed from the click on the palette row).
