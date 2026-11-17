# Design

A VS Code for Web extension that compiles, runs and debugs C/C++ entirely in the browser using
`clang.wasm`/`lld.wasm` (built by the `llvm-project` fork) and an lldb-derived symbol/value library.
Output is always WebAssembly (WASI); only minor restrictions are placed on compiler flags.

## Layout
```
src/web/
  extension.ts                 # activation, command registration
  buildWorkspace.ts            # workspace build orchestration, artifact dir choice
  projectConfig.ts             # settings, tasks.json and launch.json read from VS Code
  runProgram.ts
  tasks.ts
  buildgraph/                  # optional Make/CMake/Ninja layer (vscode-free; the core never imports it)
  clangd/                      # language client, compile-command overlay for background indexing
  host/                        # Worker host (guest WASI, RPC channel, GuestProcess)
  debug/                       # inline DAP adapter, stub channel, lldb reactor host
  toolchain/                   # vscode-free logic plus the compiler host (toolchain.ts)
  test/suite/                  # *.node.test.ts run in node, the rest under test-web
documents/
  design.md                    # overview, scope, alternatives; topics in design_<topic>.md
  design_clangd.md  design_cpptools.md  design_debug.md  design_distribution.md
  design_environments.md  design_host.md  design_build.md  design_project_model.md
scripts/                       # toolchain dist and test runner scripts
```
Reusable helpers are listed in `documents/helpers.md`.

## Components
- `src/web/extension.ts`: activation; registers the build command, debug configuration provider and inline debug adapter factory.
- `src/web/toolchain/toolchainDownload.ts` (vscode-free, node-tested) and `toolchainStore.ts` (extension-storage cache, progress UI): the toolchain loader; see `design_distribution.md`.
- `src/web/toolchain/toolchain.ts`: `build(request)` is the single boundary between VS Code UX and the compiler host. The host (Workers, WASI, spawn hook, threads) sits behind it so UX layers never touch wasm details.
- `src/web/debug/`: the debugger. `debugController.ts` holds the Debug Adapter Protocol logic and is vscode-free; it reaches the program only through the `DebuggeeSession` interface (`debuggeeSession.ts`), implemented by `stubDebuggee.ts` over the in-process stub's stdio channel (`design_debug.md`). `debugAdapter.ts` is the inline adapter shell (web extensions cannot spawn processes): it builds in debug mode, runs the program on the Worker host and hosts the lldb reactor (`reactorHost.ts`). Debugging uses compile-time instrumentation plus lldb as a library (the reactor decodes DWARF and values; `wasmScan.ts` maps coverage guards to pcs and frame-base locals), not a live attach; rationale in the llvm-project fork's `documents/design.md` ("Debugging design"). `dwarfLines.ts` and `breakpointIndex.ts` turn a source line into the guards that stop there, because the reactor can map a pc to a line but not back; `pathMapper.ts` maps the client's source paths to `/workspace`.
- `src/web/clangd/` and `src/web/toolchain/toolchainFileSystem.ts`: the clangd language client, its fallback flags, read-only header file system and background-index overlay; see `design_clangd.md`.
- Binaries (`clang.wasm`, `lld.wasm`, `lldb-wasm-reactor.wasm`, plus a sysroot tree; the `lldb.wasm` CLI is not needed, because the debugger uses lldb only as a library through the reactor's exports, never the lldb/lldb-dap command interpreter) are built by the llvm-project fork (release tree `release/llvmorg-24.0.0-git-wasi.2`: `bin/`, `sysroot/`, `resource/`, `compile-flags.json`, `MANIFEST`) and are not in the .vsix. A local copy lives under `llvm-artifacts/` (gitignored) for development; see `design_distribution.md`.

## Topic documents
- `design_distribution.md`: toolchain hosting, download, verification, prefetch.
- `design_environments.md`: the three guest environments, Wasmer run host, filesystem layout, run environment.
- `design_host.md`: Worker host, slices, build orchestration, flags and tasks.
- `design_build.md`: object cache, artifact location, PCHs.
- `design_project_model.md`: `tasks.json`/`launch.json`/`compile_commands.json` mapping and the Make build graph.
- `design_debug.md`: debug stub channel and debugger behavior.
- `design_clangd.md`: clangd client, indexing; `design_cpptools.md`: `C_Cpp.*` compatibility.

## Contract with the toolchain
The authoritative host contract (spawn hook, wasi-threads, Worker termination and cleanup) is `documents/js-host-contract.md` in the `llvm-project` fork. This extension is the real browser host that contract describes.

## Scope
North star: compile, run and debug self-contained C/C++ programs (and a library's tests) in a browser tab with nothing installed, on machines where installing a compiler is impossible or unwanted (Chromebooks, locked-down school or work machines, tablets, `github.dev`/`vscode.dev` on a repo with no cloud VM). Non-goals: a POSIX userland (shell, coreutils), networking, GUI and native-library linking, MSVC project formats, replacing desktop toolchains. Before adding a feature, check it serves the north star; most "it would be cool if programs could ..." ideas below it belong in a later, separate project.

Framed against the desktop C/C++ (cpptools) extension this project is meant to replace entirely in the browser, cpptools plays three roles, and this extension's scope maps one-to-one:
1. **Build**, reading `tasks.json`'s default build task (`g++`/`clang++`-style) — done (`design_project_model.md`).
2. **Debug**, reading `launch.json` (`cppdbg`/`cppvsdbg`) and implementing the Debug Adapter Protocol (a `DebugAdapterDescriptorFactory`/inline adapter registered for a debug type) — the inline adapter does breakpoints, stepping, variables and threads (`design_debug.md`).
3. **IntelliSense** (completion, hover, go-to-definition, diagnostics-as-you-type), via VS Code's ordinary language-provider APIs — a clangd language client (`design_clangd.md`) with background indexing on clangd's own threads.

Make, CMake and CPython support ships in this extension's codebase (this flavor of the plugin) as optional features layered around a self-sufficient core. The core (clang, lld, the lldb reactor, clangd) must never depend on them: they are wrappers over the core's public build/run entry points, loaded only when used (optional downloadable packs, see `documents/build_systems_feasibility.md`), and removing them leaves the core unchanged. They still feed the core and clangd through the neutral `compile_commands.json` format (`design_project_model.md`) wherever that suffices.

## Alternatives considered
### Custom JS-hook runner for Pause, live breakpoint changes, all-stop and traps
- Pros: the host would see every guard, so it could stop every thread exactly, show a trap with a full stack, and give exact call-site pcs at every stop.
- Cons: a new Worker runner, a hook import and a second `DebuggeeSession`. Writing guard bits and a control word in the shared memory the host already owns gives Pause, live breakpoint edits and all-stop with one extra load per hook, and a trap's stack trace plus the stub's registry gives traps as stops, so none of those need it. Only exact call-site pcs at ordinary stops (outer frames show the line of their last guard) would still need it.

### Reader thread inside the debug stub
- Pros: would apply breakpoint changes and pause while the program runs freely.
- Cons: the stub is single-threaded; stdin is shared with the program, so a reader would consume its input (the channel works only because commands and program input never overlap); does not reduce overhead, which comes from the per-basic-block hook.

### Let the other threads run while one is stopped
- Pros: no waiting for the others to reach a hook, so a stop is instant; a thread blocked in a lock or sleep needs no special handling.
- Cons: Variables and memory change under the user's eyes, other threads' stacks cannot be shown, and a second breakpoint in another thread waits for the first. This was the behavior before all-stop; the pause word every hook already loads now also carries the stopped bit, so all-stop costs no extra load.

### Hold the process on a trap by pausing the trapped thread inside the engine
- Pros: would also allow resuming past a trap.
- Cons: a wasm trap unwinds the thread's stack, so nothing can resume it; the registry's shadow stack and the engine's stack trace are all that survive, which is enough to show it.

### Build threads only when the program asks for them
- Pros: single-threaded programs keep the smaller, non-shared memory.
- Cons: `<thread>`/`<mutex>` are missing from the plain libc++, so code that merely includes them (fmt, Catch2) fails to compile without `-pthread`; `-pthread` is still honoured when `vscwclang.threads` is off.

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

### Ship a separate clang-format.wasm
- Pros: could honour `clang_format_style` strings, `sortIncludes` and `--style=` exactly like cpptools.
- Cons: another ~15 MB download and a second guest to run for a feature clangd already provides through LSP; formatting would then ignore clangd's file-system view of `.clang-format`.

### Generate a `.clang-format` above the workspace for the fallback style
- Pros: could express cpptools' real `Visual Studio` preset or inline `{...}` styles.
- Cons: an invisible file the user cannot find, which also shadows clangd's own fallback; `-fallback-style=Microsoft` is close enough.

### Archive step in the lowering instead of folding static libraries
- Pros: matches what the Makefile says; the archive could be reused by several programs.
- Cons: needs `llvm-ar` run by the host (not exposed yet), an object store the link reads from, and a core change to `build()`; the core's compile cache and per-source flags already give the reuse; the program is the same either way (wasm-ld links `.a` members lazily, a fold links every object).
