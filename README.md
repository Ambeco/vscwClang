# vscwClang

**C and C++ in VS Code for the Web: build, run and debug with Clang, entirely in your browser. Nothing to install.**

vscwClang runs WebAssembly builds of Clang, LLD and clangd inside the extension, so on [vscode.dev](https://vscode.dev) or github.dev you get a real C/C++ toolchain with no local compiler, no remote machine and no server. Everything happens in your browser tab; your code never leaves it.

> **Unofficial and early.** vscwClang is an independent project, not affiliated with or endorsed by the LLVM Project, the LLVM Foundation, or Microsoft. Expect rough edges, and please report them.

## Features

- **Build and Run** with one command. Programs run in a VS Code terminal, and `std::cin`/`stdin` work: type input into the terminal.
- **Debug with F5**: line, function, conditional and hit-count breakpoints, logpoints, step in/over/out, call stack, Variables, Watch and hover, and threads.
- **IntelliSense from clangd**: completion, hover, go to definition, as-you-type diagnostics, Format Document (clang-format), clang-tidy and inlay hints.
- **Errors in the Problems panel**, at the right file, line and column.
- **Multithreading**: `std::thread`, `std::mutex`, `std::async` and `pthread` work.
- **Works with the project you already have**: reads your `tasks.json`, `launch.json`, `.vscode/c_cpp_properties.json`, `compile_commands.json` (CMake, Bear) and the C/C++ extension's `C_Cpp.*` settings.
- **Works offline** after the first toolchain download.

## Quick start

1. Open [vscode.dev](https://vscode.dev) (Chrome or Edge recommended), then open a folder: a local folder, or a GitHub repository.
2. Install **vscwClang** from the Extensions view.
3. Open a `.cpp` file and press `F1`, then run **vscwClang: Build and Run C++**. Or press **F5** to debug.

The first build downloads the compiler and standard library (about 98 MB, from a CDN) and caches them in the extension's storage; opening a C/C++ file for the first time also downloads clangd. After that it works offline. The first build in each session spends a few seconds loading the compiler.

You need a folder open in the workspace. Opening a single file with no folder is not supported yet.

## Commands

| Command | What it does |
| --- | --- |
| `vscwClang: Build C++` | Compiles your sources and links `a.out.wasm`. |
| `vscwClang: Build and Run C++` | Builds, then runs in a terminal. |
| `vscwClang: Build and Run C++ with Arguments...` | Same, asking for command-line arguments first (remembered per workspace). |
| `vscwClang: Switch Header/Source` | Jumps between `.h` and `.cpp` (`Alt+O`). |
| `vscwClang: Download toolchain` / `Clear downloaded toolchain` / `Clear build cache` | Cache management. |

Output goes to `.vscwclang/<release or debug>/` in your folder, beside a `build.log`. Read-only or virtual folders (such as GitHub repositories on vscode.dev) use the extension's storage instead, so they still build and run. Consider adding `.vscwclang/` to your `.gitignore`.

## How it picks what to build

All matching sources are linked into **one program**, so two `main` functions will fail to link. If your folder holds several programs, narrow `vscwclang.sourceGlobs` (for example `["src/**/*.cpp"]`). IDE scratch and build-output folders (`Debug`, `x64`, `build`, `.vs`, ...) are skipped.

Settings are used in this order:

1. **Your default build task** in `tasks.json` (`group: { kind: build, isDefault: true }`), if it runs `g++`, `gcc`, `clang++` or `clang`, as the C/C++ extension's "g++ build active file" does. Its source files and its `-I`, `-D`, `-std`, `-O`, `-l` flags and `-o` name are used. Tasks that run `make`, `cmake` or `cl.exe` are ignored (with a note in the output).
2. **`compile_commands.json`** (workspace root or `build/`, or `vscwclang.compileCommands`) or `compile_flags.txt`. Each source is compiled with its own entry's flags. A CMake database with several targets asks which one to build.
3. **The `vscwclang.*` settings**: `vscwclang.flags` (default `-I/workspace`), `vscwclang.sourceGlobs` and friends. If you have not set `vscwclang.flags`, the C/C++ extension's `C_Cpp.default.*` settings (`defines`, `includePath`, `cppStandard`, `cStandard`, `compilerArgs`, `forcedInclude`) and `.vscode/c_cpp_properties.json` are added too (turn off with `vscwclang.useCppToolsSettings`).

Flags a browser cannot honour (`-static`, colour flags) are dropped and listed in the `vscwclang` output channel; forbidden ones (`-c`, `--target`) are errors with a suggestion.

You can also run builds from `tasks.json` with the `vscwclang` task type (`sources`, `flags`, `mode`, `output`).

## Running programs

- Your folder is mounted at `/workspace`, and relative paths such as `input.txt` start there.
- Run arguments come from, in order: a `cppdbg`/`cppvsdbg`/`lldb`/`codelldb` launch configuration, the `vscwclang.run.args` setting, or the "with Arguments" prompt.
- Programs can read and write files in your workspace, use stdin/stdout, and read the clock and random numbers. `HOME` is `/home/user` (kept between runs) and `TMPDIR` is `/tmp` (emptied each run). `vscwclang.run.env` adds or removes environment variables.
- There is no network and no other programs: `system()` and `popen` don't work and `fork` doesn't exist.

## Debugging

Press **F5** (a `vscwClang` launch configuration is offered). Debug builds are `-O0` and stop at:

- line breakpoints, function breakpoints, conditions (`i == 3 && p.x > 2`), hit counts (`5`, `>= 5`, `% 3`) and logpoints (`i={i}`);
- crashes: an out-of-bounds access, divide by zero, `abort()`, a failed `assert` or an uncaught exception stops in the debugger on the faulting line, with the message and call stack.

The Variables pane shows locals, structs, arrays, pointers and variable-length arrays. Hover, Watch and the Debug Console evaluate variables and simple expressions over them (`a + b`, `i < n`), but not function calls, casts, `*p` or strings. For threaded builds a stop halts every thread and the Threads list shows each one's stack; only the thread that stopped can be stepped. Pause and live breakpoint edits work while the program runs.

Program input and output are in a `vscwClang debug` terminal; set `"console": "internalConsole"` in `launch.json` for the Debug Console instead. Standard-library functions have no stops, so stepping never enters them.

## IntelliSense and formatting

A clangd language server (WebAssembly, multi-threaded) gives completion, hover, go to definition and diagnostics. It indexes your workspace in the background (progress shows as a notification) and keeps its index in extension storage, so cross-file results can be incomplete until the first pass finishes. Turn it off with `vscwclang.intelliSense.enabled` if you only need Build and Run.

- Without a `compile_commands.json`, `.h` files are analyzed as C++ (unless the workspace is C only).
- **Formatting** uses clangd's built-in clang-format and the nearest `.clang-format` file (re-read on every format). With none, `C_Cpp.clang_format_fallbackStyle` applies (default `Visual Studio`). `C_Cpp.formatting: disabled` turns it off. `vcFormat.*`, `clang_format_style` other than `file`, `clang_format_sortIncludes` and `clang_format_path` are not supported: use a `.clang-format` file.
- `C_Cpp.refactoring.includeHeader: never`, `C_Cpp.codeAnalysis.clangTidy.enabled`, `checks.enabled`/`checks.disabled` and the `inlayHints` options for parameter names and `auto` types are honored (reload to apply). Other clang-tidy options belong in a `.clang-tidy` file.

## Limitations

- **WebAssembly only.** Programs are built for `wasm32-wasip1` (WASI): they can use the C and C++ standard libraries, but not sockets, processes, graphics or native libraries.
- **32-bit.** Pointers, `size_t` and `uintptr_t` are 32 bits, so code that assumes 64-bit pointers needs changes.
- **No Windows APIs.** `windows.h`, `winsock2.h` and MSVC-only functions such as `_stricmp` and `strcpy_s` are unavailable.
- **Restricted flags.** Flags that would break the sandbox (`--target`, `-march`, `-o`, `-c`, `-fplugin`, `-fuse-ld`, `--sysroot`, `-B`, and paths outside your workspace) are rejected. `-I`, `-D`, `-std`, `-O`, `-W...`, `-l`, `-L` and `-Wl,...` work.
- **Standard headers are preloaded** to make recompiles faster: C++ files that include `<vector>`, `<string>`, `<iostream>` and similar compile against a prebuilt copy, so a forgotten `#include` of one of them is not an error here but is elsewhere. Set `vscwclang.precompiledHeaders` to `false` to compile exactly as written.
- **Threads** reserve up to 2 GiB of address space (shared memory). File I/O from threads is routed through one thread, so it is slower. `fork` and signals do not exist. Turn `vscwclang.threads` off for a plain single-threaded build.
- **Crashes** end the program with `exited with code 134 (aborted)` (failed `assert`, `abort()`, `std::terminate`, uncaught exception, which also prints its type and `what()`) or `trapped: <reason>` and exit code 139 (out-of-bounds access, division by zero, stack overflow).
- **`mmap`** can read a file, but writes through a shared mapping are not saved.
- **Make, CMake and Python are not run.** `compile_commands.json` from CMake is read, but build scripts are not executed; Make support is planned.
- **Debug builds are `-O0` only**, and Make-style multi-target projects are not yet supported.
- **Chromium browsers** (Chrome, Edge) are best supported. Local-folder access on vscode.dev needs the File System Access API.
- **Resources.** Each compile can use several hundred MB; lower `vscwclang.parallelCompiles` if the tab runs out of memory. Compiled objects are cached for faster rebuilds (`vscwclang.buildCache.*`).
- **`Tasks: Run Build Task` (Ctrl+Shift+B) does nothing on the web workbench** for any extension. Use the `vscwClang` commands from the Command Palette instead.

## Settings

Search for `vscwclang` in Settings. The most useful:

| Setting | Purpose |
| --- | --- |
| `vscwclang.flags` | Extra compiler flags (`-std=c++20`, `-DNAME=1`, `-O2`, `-lm`...). |
| `vscwclang.sourceGlobs` | Which files are linked into the program. |
| `vscwclang.files.exclude` | Folders never compiled or indexed. |
| `vscwclang.run.args` / `vscwclang.run.env` | Program arguments and environment. |
| `vscwclang.compileCommands` | Path to a `compile_commands.json`. |
| `vscwclang.threads` | Threaded standard library (on by default). |
| `vscwclang.intelliSense.enabled` | Turn clangd on or off. |
| `vscwclang.useCppToolsSettings` | Reuse the C/C++ extension's `C_Cpp.*` settings and `.vscode/c_cpp_properties.json`. |

## Licenses

vscwClang is under the Apache License v2.0 with LLVM Exceptions, the same license as Clang. See `LICENSE` and `THIRD_PARTY_NOTICES.md`. The downloaded toolchain is built from the LLVM Project and the wasi-libc and libc++ libraries.

## For contributors

Build instructions, design notes and the remaining work are in [DEV_README.md](https://github.com/Ambeco/vscwClang/blob/main/DEV_README.md). Issues and feedback: [github.com/Ambeco/vscwClang/issues](https://github.com/Ambeco/vscwClang/issues).

Designed and overseen by [Ambeco](https://github.com/Ambeco), and coded mostly by Claude.
