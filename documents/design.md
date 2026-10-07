# Design

A VS Code for Web extension that compiles, runs and debugs C/C++ entirely in the browser using
`clang.wasm`/`lld.wasm` (built by the `llvm-project` fork) and an lldb-derived symbol/value library.
Output is always WebAssembly (WASI); only minor restrictions are placed on compiler flags.

## Components
- `src/web/extension.ts`: activation; registers the build command, debug configuration provider and inline debug adapter factory.
- `src/web/toolchain/toolchainDownload.ts` (vscode-free, node-tested) and `toolchainStore.ts` (extension-storage cache, progress UI): the toolchain loader; see Distribution.
- `src/web/toolchain/toolchain.ts`: `build(request)` is the single boundary between VS Code UX and the compiler host. The host (Workers, WASI, spawn hook, threads) sits behind it so UX layers never touch wasm details.
- `src/web/debug/debugAdapter.ts`: an inline DAP adapter (a plain object in the extension host, since web extensions cannot spawn processes). Debugging uses compile-time instrumentation plus lldb as a library, not a live attach; rationale in the llvm-project fork's `documents/design.md` ("Debugging design").
- Binaries (`clang.wasm`, `lld.wasm`, `lldb.wasm`, `lldb-wasm-reactor.wasm`, plus a sysroot tree) are built by the llvm-project fork (release tree `release/llvmorg-24.0.0-git-wasi.2`: `bin/`, `sysroot/`, `resource/`, `compile-flags.json`, `MANIFEST`) and are not in the .vsix. A local copy lives under `llvm-artifacts/` (gitignored) for development; see Distribution.

## Contract with the toolchain
The authoritative host contract (spawn hook, wasi-threads, Worker termination and cleanup) is `documents/js-host-contract.md` in the `llvm-project` fork. This extension is the real browser host that contract describes.

## Distribution
The core extension is small and ships no toolchain. On first use it downloads zips of the toolchain (clang + lld, sysroot + resource dir, later lldb) from a host that sends `Access-Control-Allow-Origin` and `Cross-Origin-Resource-Policy: cross-origin`, as vscode.dev is `COEP: require-corp`. `raw.githubusercontent.com`, jsDelivr and unpkg do; GitHub *release assets* do not. Each zip is unzipped in the extension host (`fflate`), verified against SHA-256 hashes embedded in the core extension (which replace Marketplace signing for these files), and cached in extension storage. Files over the host's per-file cap are split into chunks (`scripts/split-wasm.mjs`, `src/web/toolchain/chunkedFile.ts`) and reassembled before compiling. `WebAssembly.compile` then runs on the unzipped bytes and `wasm-wasi-core` executes them; this path (unzip, compile, run `clang --version`) is verified. The sysroot is unzipped into a `wasm-wasi-core` memory file system mounted read-only at `/sysroot`; flags come from the release's `compile-flags.json`. 
The loader (`toolchainDownload.ts`, `toolchainStore.ts`): the extension pins one SHA-256, of the toolchain's `manifest.json` (`toolchainPin.ts`, written by `scripts/make-toolchain-dist.mjs --pin`). The manifest lists each file's final size and hash plus its payload chunks (each with its own size and hash; `clang.wasm`/`lld.wasm` payloads are zips, `sysroot.zip` and `compile-flags.json` are raw). Chunks download four at a time with retries (not on 4xx other than 408/429), each verified before use; the result is unzipped, checked against the file hash, and only then written to `globalStorageUri/toolchain/<manifest hash>/`. A cached file is trusted only if its size and hash match, so an interrupted download resumes per file and a pinned toolchain works offline. Other cached versions are deleted after a successful download. One notification shows progress for everything still missing (cancellable; completed files are kept). The sysroot stays cached as its zip; unzipping into the memory file system happens once per session. The application-scoped setting `vscwclang.toolchainUrl` replaces the host and skips the pin (development; a workspace cannot set application-scoped settings), and is how tests and local runs use `llvm-artifacts/dist`. If the pinned hash is ever empty, `build()` fails with a message that says so.

Hosting layout: the unchunked, generic artifacts (`clang.wasm`, `lld.wasm`, `lldb.wasm`, reactor, sysroot) are GitHub releases of the `Ambeco/llvm-project` fork, the source of truth. What the extension downloads is served from a separate public repo (`Ambeco/llvm-artifacts`, files under `dist/`): the chunked/zipped copies produced by `scripts/split-wasm.mjs` / `scripts/zip-wasm.mjs`, `compile-flags.json`, and a manifest with SHA-256 hashes, fetched through jsDelivr or raw.githubusercontent.com at an immutable tag per toolchain version (e.g. `https://cdn.jsdelivr.net/gh/Ambeco/llvm-artifacts@v24.0.0/dist/...`). The extension pins the tag, so a toolchain change ships as an extension update. The toolchain repo is kept small by publishing each version as an orphan commit (or force-pushing a branch), never accumulating history; chunks stay at 16 MiB, well under per-file caps. Only extension-specific files (`compile-flags.json`, manifest) belong to this layout; this extension repo holds no binaries.

## Host
V1 uses `wasm-wasi-core` (a separate VS Code extension; it requires `SharedArrayBuffer`, available on vscode.dev) to run a single-process, single-thread `clang.wasm` (cc1 in-process) and `lld.wasm`, orchestrated by the extension. `toolchain.build()` compiles each source with `clang++`/`clang` (`-c -o -`: clang writes each object to stdout, the host puts it in an in-memory file system mounted read-only at `/obj` for `wasm-ld`, so only the final `.wasm` is written to the workspace), keeps going after a failed compile so all diagnostics are reported, then links with `wasm-ld`. User flags are checked first by `flagPolicy.ts` (rejections carry did-you-mean text); clang/wasm-ld text output is parsed by `diagnostics.ts` and published by `diagnosticsCollection.ts`. Compiled `clang.wasm`/`lld.wasm` modules and the unzipped sysroot are cached in memory across builds. `wasm-wasi-core` cannot host the spawn hook: it never exposes the `WebAssembly.Instance` or custom imports. Concurrent per-file compiles, spawned cc1/wasm-ld and in-module threads therefore need V2, our own Worker host following `js-host-contract.md`. User programs can still be run under `wasm-wasi-core`.

## Flags, run and tasks
`request.flags` is one list; `splitFlags` (flagPolicy.ts) routes `-l`, `-L` (relative dirs resolved under `/workspace`) and `-Wl,a,b` (split into separate args) to wasm-ld, everything else to `clang -c`. `vscwclang.run` (`runProgram.ts`) builds, then runs the .wasm under `wasm-wasi-core` with `createPseudoterminal()` as stdin/stdout/stderr: stdin is the terminal's line mode (echo, line editing, one line per Enter, no EOF key); Ctrl+C or closing the terminal terminates the process. `tasks.ts` provides `vscwclang` build tasks as `CustomExecution` that print clang's text; the `$vscwclang` matcher turns `/workspace/<file>:l:c: error|warning:` lines into Problems (notes and linker lines are not matched).

## Scope
North star: compile, run and debug self-contained C/C++ programs (and a library's tests) in a browser tab with nothing installed, on machines where installing a compiler is impossible or unwanted (Chromebooks, locked-down school or work machines, tablets, `github.dev`/`vscode.dev` on a repo with no cloud VM). Non-goals: a POSIX userland (shell, coreutils), networking, GUI and native-library linking, MSVC project formats, replacing desktop toolchains. Before adding a feature, check it serves the north star; most "it would be cool if programs could ..." ideas below it belong in a later, separate project.

## Run environment
User programs run under `wasm-wasi-core` (WASI preview 1). A program sees only what is mounted: the workspace at `/workspace`; there is no `/tmp`, `/etc`, `/home` or `/dev`. The environment is empty unless given (so `getenv("HOME")` is null), and there is no cwd beyond the mounts. Sockets are stubbed (`sock_*` return not-implemented; preview 1 has no `connect`), and there are no processes or signals. Mount kinds available: workspace folder, any VS Code file system (writable), extension files, and an in-memory file system (read-only to the guest). Planned defaults: `HOME=/home/user`, `TMPDIR=/tmp`, `USER`, `LANG`, extendable by `vscwclang.run.env`, and writable `/tmp` and `/home/user` mounts backed by extension storage.

Library-level behavior (wasi-libc, verified by building and running under Node WASI): `fork` and `popen` are undeclared, so using them is a compile error; `system()` is declared but undefined, so it is a link error (`undefined symbol: system`); `msync` is a link error; `mmap` needs `-D_WASI_EMULATED_MMAN` and `-lwasi-emulated-mman` and only emulates reading (file contents are copied into memory): a write through a `MAP_SHARED` mapping is silently NOT written back to the file. `fopen("/tmp/...")` fails. A failed `assert`, `abort()` or `std::terminate` exits 134 through a weak `abort()` helper linked into every program, since a trap would hang `run()`.

## Build artifacts
Objects live in memory only. The linked `.wasm` and logs go where the user can reach them. For local, writable folders: inside the folder (under `.vscwclang/<mode>/`, so debug and release builds from two tabs or two synced devices do not collide); this also lets a synced folder share them across devices. For read-only or virtual folders (`vscode-vfs://` repos, where a written file would also show up as a pending change in Source Control) they go in extension storage instead, which lets read-only repositories build and run. A setting overrides either default. Caches shared between devices must be content-addressed (hash of source, flags and toolchain) so concurrent writers cannot clash.

## Project model and integration
Goal: a desktop VS Code project that builds with clang should build, run and debug the same here. `toolchain.build(request)` (sources, flags, output, mode) stays the only boundary to the compiler; a "project model" step in front of it turns what the workspace already contains into that request. This extension owns the clang-compatible inputs desktop VS Code uses: `tasks.json` (`cppbuild`/shell tasks that call `g++`/`clang++`, mapped through `flagPolicy`) and `launch.json` (`program`, `args`). Solution and project files (`.sln`, `.vcxproj`) are out of scope because they almost always target non-clang compilers and flags.

Other build systems (Make, CMake, Bazel, Meson) belong in separate extensions, which cannot run `make`/`cmake` as native processes on the web anyway. They integrate through `compile_commands.json`, the neutral compilation-database format (`directory`, `command` or `arguments`, `file` per translation unit) already read by clangd and cpptools: this extension reads it as one more source of build plans, so any tool that emits it works with no code dependency. A versioned exported API (like the Git extension's `getAPI(1)`) and a command accepting a plain-data build request are the tighter options if needed later; the `vscwclang` task type is already a declarative form of the same request.

## Alternatives considered
### Write build artifacts only to extension storage
- Pros: never touches the user's folder; works for read-only repositories.
- Cons: the user cannot reach the binary or logs, and nothing is shared across devices; used only for read-only or virtual folders.

### Parse Visual Studio solution and project files
- Pros: opens existing Windows projects directly.
- Cons: they target MSVC (`/std:`, `/W4`, Windows APIs, 64-bit assumptions), so almost none would compile with clang for wasm32 anyway; a large parser for little gain.

### Make a dedicated build-system extension call this one through a hard dependency
- Pros: simplest for the other extension; typed calls.
- Cons: couples release cycles; every build tool must know this extension. A shared file format (`compile_commands.json`) needs no coupling and also serves clangd.

### Ship the toolchain in Marketplace tooling extensions
- Pros: Marketplace signing and versioning; files served by the workbench with no CORS concerns.
- Cons: Marketplace per-vsix and per-file size caps are undocumented (reported 20-25 MB; clang alone is 24 MB gzipped), so it could need ~7 extensions kept in version lockstep; needs a publisher account per extension set; programmatic install on vscode.dev is unverified.

### Serve the chunked toolchain from this extension repo
- Pros: one repo; no extra hosting setup.
- Cons: every toolchain version's chunks (~100+ MB each) stay in git history forever, bloating clones of the extension repo; mixing binary releases with extension source makes history and tags confusing.

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
