# Remaining work

Open items only, in build order. Design context: `documents/design.md`. Upstream toolchain/debugger
context: the `llvm-project` fork's `documents/` (`js-host-contract.md`, `vscode-wasi-host.md`,
`design.md` "Debugging design"). A template scaffold exists (build command, inline debug adapter,
toolchain boundary, all failing loudly); everything below replaces a stub.

## Milestone 0: decisions to make before writing host code
- **Embed vs. fetch the toolchain binaries (TBD).** `llvm-artifacts/` holds the latest `clang.wasm` (~114 MB), `lld.wasm` (~68 MB), `lldb.wasm` (~100 MB), `lldb-wasm-reactor.wasm` (~100 MB), `SHA256SUMS`, `SHA256SUMS.asc` and `ambeco-public.asc` (~380 MB total). Options: (a) embed in the extension; (b) fetch on first use from https://github.com/Ambeco/llvm-project/releases#release-llvmorg-24.0.0-git-wasi.1, cache in Cache Storage/IndexedDB, `WebAssembly.compileStreaming`. Embedding looks impractical at ~380 MB (marketplace/vsix size limits, install/update cost), so fetch is the leading candidate; confirm size limits and that GitHub release asset downloads allow CORS from the web extension host before deciding. Either way: verify downloads against `SHA256SUMS`, checked against the `SHA256SUMS.asc` signature with `ambeco-public.asc` (decide whether in-browser PGP verification is worth it vs. checksums pinned in the extension), plus a download progress UI and a version pin.
- **Sysroot source.** Need wasi-libc + libc++ headers/libs + compiler-rt builtins (for `wasm32-wasip1`, and `-threads` if offered) packaged as one archive. Confirm what the llvm-project fork already produces (its builtins were a separate build pass) and how it is unpacked into the in-memory FS.
- **Own WASI host vs. `wasm-wasi-core` (vscode-wasm).** Our spawn hook, wasi-threads and threaded-I/O shim are proven only on a hand-written Node host. Spike both against the real binaries. Default plan: own minimal host inside a Worker; use `wasm-wasi-core` only if it handles imported shared memory plus our table-hook cleanly.
- **Cross-origin isolation.** Threads and the debugger pause mechanism need `SharedArrayBuffer`. Verify what vscode.dev / github.dev / `@vscode/test-web` give web extension workers. If unavailable: single-threaded `clang.wasm` build, and a different pause design for debugging.

## Milestone 1: compile in the browser
- Worker-hosted `clang.wasm` driver: instantiate, install spawn hook (`cc1`, `wasm-ld`), `$COLUMNS`, preopens (workspace mount, in-memory `/tmp`, read-only sysroot).
- Mirror workspace files (`vscode.workspace.fs`) into the guest FS and write outputs back.
- Implement `toolchain.build()` for real: compile each source (one driver instance per file, concurrently), then link; capture stderr as clang diagnostics.
- Cancel: terminate the Worker, then call `RunInterruptHandlers()`/`CleanupOnSignal()` from JS to remove temp files.
- Flag policy: force `--target=wasm32-wasip1[-threads]`; reject `-fplugin`, `-fuse-ld`, `-B`, `--sysroot` overrides, host-path `-I` outside workspace/sysroot, other `-march`/targets, with "did you mean" errors.
- Surface diagnostics: parse clang output into a `vscode.DiagnosticCollection`.
- Tests under `@vscode/test-web`: hello world and a multi-file project.

## Milestone 2: tasks, build UX, run
- `TaskProvider` (`type: "vscwclang"`) with problem matcher and default build task; `tasks.json` schema (sources glob, flags, mode).
- Settings: toolchain version/URL, default `-std`, extra flags, threads on/off.
- Run without debugging: `Pseudoterminal` wired to the program's stdin/stdout/stderr (Worker + WASI).
- Optional: run in a separate browser tab for OS-level sandboxing (open questions in the llvm-project fork's `remaining_work.md`).

## Milestone 3: language support (optional, high value)
- Basic C++ editing UX (snippets, file associations); possibly a clangd.wasm later as a separate effort.

## Milestone 4: debug build + hook runtime
- "Debug" mode flags: `-O0 -g -fsanitize-coverage=trace-pc-guard -Wl,--export=__stack_pointer`; decide hook granularity (trace-pc-guard vs. per-line pass) and measure overhead.
- Provide the hook import (`__sanitizer_cov_trace_pc_guard`) from JS; map guard -> pc -> source line.
- Run the debuggee in its own Worker; pause synchronously inside the hook via `Atomics.wait` on a shared buffer; resume on continue/step.
- JS-side shadow call stack from `__stack_pointer` deltas between hook firings (see llvm-project design.md).

## Milestone 5: lldb reactor integration
- Add `lldb-wasm-reactor.wasm` to the toolchain bundle and host it (imported `read_memory`/`write_memory`; spawned threads need the same imports and must not call `_initialize`).
- `wasm_dbg_init` / `create_target` on build output; `resolve_pc` for line mapping; `set_stop` + `format_value` for variables.
- **Blocked upstream (llvm-project fork):** frame 1+ symbol resolution bug (third and later DWARF function in a module resolves to the first). Needed for multi-frame backtraces.
- The reactor is not in `built-snapshot/` today; produce and publish it.

## Milestone 6: full DAP surface
- Breakpoints (line, function, hit count), step in/over/out, continue, pause.
- Threads, stack trace, scopes, variables (structs/arrays/pointers expand), hover/watch (variable-path subset only; no JIT expression evaluator, by decision).
- Wasm traps map to a stopped state with a stack.
- Debug console I/O, `launch` args/env/cwd, `terminate`/`disconnect` cleanup.

## Milestone 7: release
- Marketplace packaging (web-only, no bundled binaries), toolchain download integrity check, CI running the web tests, README screenshots, CHANGELOG.

## Known risks / open questions
- Compile speed and memory: 2 GiB max-memory per `clang.wasm` instance, times N concurrent files, in one browser tab.
- Nested Worker limits (threads/spawn) inside the web extension host are unverified.
- Debugging is `-O0`-only by design; DWARF frame-base for optimized code is unverified.
- The `@vscode/test-web` run (downloads Chromium) has not been executed yet.
