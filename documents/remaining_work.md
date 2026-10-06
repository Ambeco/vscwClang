# Remaining work

Open items only, in build order. Design context: `documents/design.md`. Upstream toolchain/debugger
context: the `llvm-project` fork's `documents/` (`js-host-contract.md`, `vscode-wasi-host.md`,
`design.md` "Debugging design"). A template scaffold exists (build command, inline debug adapter,
toolchain boundary, all failing loudly); everything below replaces a stub.

## Milestone 0: decisions to make before writing host code
- **Binary distribution: download-and-cache from a CORS-open host (design.md "Distribution"); tooling extensions are the fallback** (see Plan below and design.md "Distribution"). Direct GitHub release-asset download was tested 2026-10-03 from vscode.dev and fails CORS/COEP (`release-assets.githubusercontent.com` sends no `Access-Control-Allow-Origin`; only `api.github.com` metadata is CORS-open), which is why.
- **Sysroot source (what this item was):** clang needs, at compile time, (1) the wasi-libc + libc++/libc++abi headers and libs for `wasm32-wasip1` (and `wasm32-wasip1-threads` if we offer threaded user programs), and (2) the clang resource dir (`lib/clang/24/`: compiler-rt builtins for plain `wasm32-wasip1`, plus `libclang_rt.wasi_threaded_io` for `-pthread`). Today the smoke tests use the local wasi-sdk 34 `share/wasi-sysroot` (421 MB with wasip2/p3 and unused variants; only the wasip1 and wasip1-threads dirs plus `include/` are needed) and `llvm-project/build/lib/clang/24`. Neither is in the release assets. To do: define a trimmed sysroot archive (headers, `lib/wasm32-wasip1{,-threads}`, resource dir), produce it from the fork's build, publish and hash it like the other binaries, and mount it read-only at `/sysroot`. Measure its size.
- **Host: decided, `wasm-wasi-core` for V1, own host for V2.** `wasm-wasi-core` instantiates modules inside its own workers with fixed imports and never exposes the `WebAssembly.Instance`, so the spawn hook (table grow + `__wasi_shim_set_spawn_hook`) cannot be installed; V1 therefore needs the no-spawn single-process build below. Read via summarizing fetch of `process.ts`/`threadWorker.ts`/`mainWorker.ts`; re-confirm against source.
- **Cross-origin isolation / SharedArrayBuffer: available on vscode.dev (verified), rest unverified.** 2026-10-03: `vscode.dev`, `insiders.vscode.dev` and `github.dev` (302 to vscode.dev) all serve `COOP: same-origin` + `COEP: require-corp`, and a live vscode.dev page reports `crossOriginIsolated === true` and `typeof SharedArrayBuffer === 'function'`. This is a change from the 2023 VS Code blog (opt-in via `?vscode-coi=on`). Not yet verified: that the web *extension host worker* (different origin, `vscode-cdn`) is itself isolated: write a probe extension that logs `self.crossOriginIsolated` from `activate()` and from a nested Worker, and try constructing a shared `WebAssembly.Memory`. Also unverified: `@vscode/test-web` (historically not isolated, microsoft/vscode-test-web#14) and self-hosted VS Code web. V1 (single-thread) needs no threads, but `wasm-wasi-core` itself and the debugger pause need `SharedArrayBuffer`. Note COEP means every cross-origin resource we load needs CORS/CORP, which is the same constraint as the download problem above.
- **Plan (decided): V1 on `wasm-wasi-core`, single-process and single-thread; V2 custom host.** V1 runs `clang -c` per file with cc1 in-process, then calls `lld.wasm` directly from the extension, so no spawn hook or threads are needed and `wasm-wasi-core` suffices. Toolchain binaries and the sysroot ship in Marketplace-distributed tooling extensions (see design.md "Distribution"), which also removes the GitHub CORS download problem. V2 replaces the host with our own Worker host (spawn hook, concurrent per-file compiles, wasi-threads) if V1's limits matter. Open checks, in order, via a probe extension: (1) `crossOriginIsolated` / shared `WebAssembly.Memory` inside the web extension host worker; (2) `wasm-wasi-core` loading a ~100 MB `.wasm` from an extension URI via `Wasm.compile(Uri)`; (3) a core extension programmatically installing a tooling extension on vscode.dev (`workbench.extensions.installExtension`), since extension-pack install is not known to be lazy; (4) Marketplace per-vsix size limit vs. zipped `clang.wasm`/`lld.wasm`/`lldb.wasm`.
- **Toolchain release now local** (`llvm-artifacts/`, from `llvm-project/release/llvmorg-24.0.0-git-wasi.2`, gitignored): single-thread and threaded clang/lld, lldb, reactor, a 182 MB sysroot, `resource/lib/clang/24`, `compile-flags.json`. Gzip sizes: clang 24 MB, lld 14 MB, lldb 22 MB, sysroot 51 MB. Marketplace per-vsix limit not yet checked against these. Probe command `vscwClang: Probe environment (dev)` (`src/web/probe.ts`) covers checks (1) and (2); (3) and (4) are manual. Run 2026-10-05 with `npx vscode-test-web --browser=none --coi --extensionId=ms-vscode.wasm-wasi-core --extensionDevelopmentPath=. .` (driven from the in-app browser; without `--coi` the host is not isolated): extension host and nested Worker are `crossOriginIsolated` with shared `WebAssembly.Memory`; `Wasm.load()` works; reading `clang.wasm` (114 MB) from the extension URI and `WebAssembly.compile` took ~1 s (28 imports, 4 exports). Checks (1) and (2) pass under test-web `--coi`; not yet confirmed on real vscode.dev. Still open: (3) tooling-extension install/`extensionDependencies` behavior on vscode.dev, and (4) the Marketplace vsix size limit (a search snippet claims 20 MB, unconfirmed; vsmarketplace#1541 says the limit is undocumented; gzipped clang is 24 MB, so this could be decisive). Limits may differ per level: per-vsix (core vs. each tooling extension), an extension pack's total (a pack only references members, so likely no combined cap), and per individual file inside a vsix (e.g. one 114 MB `clang.wasm` entry, uncompressed). Test each separately; loading from anywhere other than installed extensions is effectively ruled out (CORS/COEP), so if any cap bites the fallback is chunking: split `clang.wasm` into N files (or N tooling extensions), `readFile` each, concatenate into one buffer, `WebAssembly.compile`. External hosting is NOT ruled out: from the extension host under test-web `--coi` (COEP on), `fetch` succeeded 2026-10-05 against raw.githubusercontent.com, cdn.jsdelivr.net and unpkg.com (all send ACAO `*` + CORP `cross-origin`), including a 9 MB jsDelivr file in 460 ms. Only GitHub *release assets* fail. Untested: large (>20 MB) files on those hosts and their size limits (jsDelivr/GitHub per-file caps), and real vscode.dev (its CSP could differ from test-web). Chunk loader exists (`scripts/split-wasm.mjs`, `src/web/toolchain/chunkedFile.ts`) and was verified 2026-10-05 under test-web `--coi`: 7 x 16 MiB chunks reassembled, SHA-256 matched, compiled in ~1.6 s.

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

## Distribution work (new)
- Pick the host (raw GitHub vs. jsDelivr/npm vs. Pages): check per-file size caps with a real >20 MB file, and brotli/gzip behavior; test on real vscode.dev, not just test-web `--coi`.
- Build the downloader: fetch zips, unzip with `fflate`, SHA-256 check against hashes embedded at build time, cache in extension storage, progress UI, retry/offline errors with "did you mean" messages.
- Verified 2026-10-05 under test-web `--coi`: `clang.zip` (25 MB, from `scripts/zip-wasm.mjs`) unzipped, compiled and ran `clang --version` (exit 0, 2.4 s).
