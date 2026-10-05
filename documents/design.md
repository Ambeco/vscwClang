# Design

A VS Code for Web extension that compiles, runs and debugs C/C++ entirely in the browser using
`clang.wasm`/`lld.wasm` (built by the `llvm-project` fork) and an lldb-derived symbol/value library.
Output is always WebAssembly (WASI); only minor restrictions are placed on compiler flags.

## Components
- `src/web/extension.ts`: activation; registers the build command, debug configuration provider and inline debug adapter factory.
- `src/web/toolchain/toolchain.ts`: `build(request)` is the single boundary between VS Code UX and the compiler host. The host (Workers, WASI, spawn hook, threads) sits behind it so UX layers never touch wasm details.
- `src/web/debug/debugAdapter.ts`: an inline DAP adapter (a plain object in the extension host, since web extensions cannot spawn processes). Debugging uses compile-time instrumentation plus lldb as a library, not a live attach; rationale in the llvm-project fork's `documents/design.md` ("Debugging design").
- Binaries (`clang.wasm`, `lld.wasm`, `lldb.wasm`, `lldb-wasm-reactor.wasm`, plus a sysroot archive) are checked in locally under `llvm-artifacts/` with `SHA256SUMS`, a detached signature and the public key. They are built by the llvm-project fork (release `llvmorg-24.0.0-git-wasi.1`) and shipped in tooling extensions; see Distribution and Host below.

## Contract with the toolchain
The authoritative host contract (spawn hook, wasi-threads, Worker termination and cleanup) is `documents/js-host-contract.md` in the `llvm-project` fork. This extension is the real browser host that contract describes.

## Distribution
The toolchain ships as Marketplace extensions, not downloads: a core extension (this repo: commands, tasks, debug adapter, host glue) plus one tooling extension per binary set (clang + sysroot, lld, later lldb). Files inside an extension are served to the extension host by the workbench, which sidesteps CORS/COEP problems with fetching GitHub release assets (release-asset hosts send no `Access-Control-Allow-Origin`; vscode.dev is `COEP: require-corp`) and replaces our own hash/PGP verification and version pinning with Marketplace signing and versions. The core extension installs tooling extensions on first use rather than relying on extension-pack install. The sysroot is a plain directory tree inside the clang tooling extension, mounted read-only at `/sysroot` via `wasm-wasi-core`'s `extensionLocation` mount.

## Host
V1 uses `wasm-wasi-core` (a separate VS Code extension; it requires `SharedArrayBuffer`, available on vscode.dev) to run a single-process, single-thread `clang.wasm` (cc1 in-process) and `lld.wasm`, orchestrated by the extension. `wasm-wasi-core` cannot host the spawn hook: it never exposes the `WebAssembly.Instance` or custom imports. Concurrent per-file compiles, spawned cc1/wasm-ld and in-module threads therefore need V2, our own Worker host following `js-host-contract.md`. User programs can still be run under `wasm-wasi-core`.

## Alternatives considered
### Bundle the wasm binaries in the .vsix
- Pros: works offline immediately; simple.
- Cons: ~380 MB (clang, lld, lldb, lldb reactor) exceeds practical extension size limits and slows every install/update.

### Use the browser's own debugger (CDP / DevTools DWARF extension)
- Pros: no instrumentation needed.
- Cons: unreachable from a web extension host (no `chrome.*`/CDP); settled "no" in the fork's notes.

### Run a wasm interpreter to control execution
- Pros: full step control.
- Cons: large correctness surface; much slower than V8's JIT.
