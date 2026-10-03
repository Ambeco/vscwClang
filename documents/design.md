# Design

A VS Code for Web extension that compiles, runs and debugs C/C++ entirely in the browser using
`clang.wasm`/`lld.wasm` (built by the `llvm-project` fork) and an lldb-derived symbol/value library.
Output is always WebAssembly (WASI); only minor restrictions are placed on compiler flags.

## Components
- `src/web/extension.ts`: activation; registers the build command, debug configuration provider and inline debug adapter factory.
- `src/web/toolchain/toolchain.ts`: `build(request)` is the single boundary between VS Code UX and the compiler host. The host (Workers, WASI, spawn hook, threads) sits behind it so UX layers never touch wasm details.
- `src/web/debug/debugAdapter.ts`: an inline DAP adapter (a plain object in the extension host, since web extensions cannot spawn processes). Debugging uses compile-time instrumentation plus lldb as a library, not a live attach; rationale in the llvm-project fork's `documents/design.md` ("Debugging design").
- Binaries (`clang.wasm`, `lld.wasm`, `lldb.wasm`, `lldb-wasm-reactor.wasm`, plus a sysroot archive) are checked in locally under `llvm-artifacts/` with `SHA256SUMS`, a detached signature and the public key. Whether the extension embeds them or fetches them from the llvm-project fork's GitHub release (`llvmorg-24.0.0-git-wasi.1`) is undecided; see remaining_work, Milestone 0.

## Contract with the toolchain
The authoritative host contract (spawn hook, wasi-threads, Worker termination and cleanup) is `documents/js-host-contract.md` in the `llvm-project` fork. This extension is the real browser host that contract describes.

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
