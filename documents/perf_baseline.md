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

Not measured yet: many-object link (Catch2 SelfTest, 166 objects), program run startup, debug-mode compile/link and `.debug_line` parse, clangd (`--check` timings and background-index time/memory need Node WASI clangd or a live vscode.dev pass), debug launch-to-breakpoint and step latency (browser).
