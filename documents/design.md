# Design

A VS Code for Web extension that compiles, runs and debugs C/C++ entirely in the browser using
`clang.wasm`/`lld.wasm` (built by the `llvm-project` fork) and an lldb-derived symbol/value library.
Output is always WebAssembly (WASI); only minor restrictions are placed on compiler flags.

## Components
- `src/web/extension.ts`: activation; registers the build command, debug configuration provider and inline debug adapter factory.
- `src/web/toolchain/toolchain.ts`: `build(request)` is the single boundary between VS Code UX and the compiler host. The host (Workers, WASI, spawn hook, threads) sits behind it so UX layers never touch wasm details.
- `src/web/debug/debugAdapter.ts`: an inline DAP adapter (a plain object in the extension host, since web extensions cannot spawn processes). Debugging uses compile-time instrumentation plus lldb as a library, not a live attach; rationale in the llvm-project fork's `documents/design.md` ("Debugging design").
- Binaries (`clang.wasm`, `lld.wasm`, `lldb.wasm`, `lldb-wasm-reactor.wasm`, plus a sysroot tree) are built by the llvm-project fork (release tree `release/llvmorg-24.0.0-git-wasi.2`: `bin/`, `sysroot/`, `resource/`, `compile-flags.json`, `MANIFEST`) and are not in the .vsix. A local copy lives under `llvm-artifacts/` (gitignored) for development; see Distribution.

## Contract with the toolchain
The authoritative host contract (spawn hook, wasi-threads, Worker termination and cleanup) is `documents/js-host-contract.md` in the `llvm-project` fork. This extension is the real browser host that contract describes.

## Distribution
The core extension is small and ships no toolchain. On first use it downloads zips of the toolchain (clang + lld, sysroot + resource dir, later lldb) from a host that sends `Access-Control-Allow-Origin` and `Cross-Origin-Resource-Policy: cross-origin`, as vscode.dev is `COEP: require-corp`. `raw.githubusercontent.com`, jsDelivr and unpkg do; GitHub *release assets* do not. Each zip is unzipped in the extension host (`fflate`), verified against SHA-256 hashes embedded in the core extension (which replace Marketplace signing for these files), and cached in extension storage. Files over the host's per-file cap are split into chunks (`scripts/split-wasm.mjs`, `src/web/toolchain/chunkedFile.ts`) and reassembled before compiling. `WebAssembly.compile` then runs on the unzipped bytes and `wasm-wasi-core` executes them; this path (unzip, compile, run `clang --version`) is verified. The sysroot is unzipped into a `wasm-wasi-core` memory file system mounted read-only at `/sysroot`; flags come from the release's `compile-flags.json`. Hosting location and the cache implementation are open (remaining_work.md).

## Host
V1 uses `wasm-wasi-core` (a separate VS Code extension; it requires `SharedArrayBuffer`, available on vscode.dev) to run a single-process, single-thread `clang.wasm` (cc1 in-process) and `lld.wasm`, orchestrated by the extension. `toolchain.build()` compiles each source with `clang++`/`clang` (`-c`, objects in a temporary `.vscwclang/obj` workspace folder since memory-FS mounts are read-only to the guest), keeps going after a failed compile so all diagnostics are reported, then links with `wasm-ld`. User flags are checked first by `flagPolicy.ts` (rejections carry did-you-mean text); clang/wasm-ld text output is parsed by `diagnostics.ts` and published by `diagnosticsCollection.ts`. Compiled `clang.wasm`/`lld.wasm` modules and the unzipped sysroot are cached in memory across builds. `wasm-wasi-core` cannot host the spawn hook: it never exposes the `WebAssembly.Instance` or custom imports. Concurrent per-file compiles, spawned cc1/wasm-ld and in-module threads therefore need V2, our own Worker host following `js-host-contract.md`. User programs can still be run under `wasm-wasi-core`.

## Alternatives considered
### Ship the toolchain in Marketplace tooling extensions
- Pros: Marketplace signing and versioning; files served by the workbench with no CORS concerns.
- Cons: Marketplace per-vsix and per-file size caps are undocumented (reported 20-25 MB; clang alone is 24 MB gzipped), so it could need ~7 extensions kept in version lockstep; needs a publisher account per extension set; programmatic install on vscode.dev is unverified.

### Download from GitHub release assets
- Pros: natural place to publish the fork's builds.
- Cons: `release-assets.githubusercontent.com` sends no CORS headers, so vscode.dev's COEP blocks the fetch.
### Bundle the wasm binaries in the .vsix
- Pros: works offline immediately; simple.
- Cons: ~380 MB (clang, lld, lldb, lldb reactor) exceeds practical extension size limits and slows every install/update.

### Use the browser's own debugger (CDP / DevTools DWARF extension)
- Pros: no instrumentation needed.
- Cons: unreachable from a web extension host (no `chrome.*`/CDP); settled "no" in the fork's notes.

### Run a wasm interpreter to control execution
- Pros: full step control.
- Cons: large correctness surface; much slower than V8's JIT.
