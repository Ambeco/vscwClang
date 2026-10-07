# vscwClang

C and C++ in Visual Studio Code for Web: compile and run with Clang, entirely in your browser, with nothing installed.

vscwClang runs WebAssembly builds of Clang and LLD inside the extension, so on vscode.dev or github.dev you can build and run C/C++ code with no local compiler, no remote machine and no server. Everything happens in your browser tab; your code never leaves it.

> **Unofficial.** vscwClang is an independent project. It is not affiliated with or endorsed by the LLVM Project, the LLVM Foundation, or Microsoft.

## What it does

- **Build** (`vscwClang: Build C++`): compiles every `.c`, `.cc`, `.cpp` and `.cxx` file in your workspace and links them into `a.out.wasm`. IDE scratch and build-output folders (`Debug`, `x64`, `build`, `enc_temp_folder`, `.vs`, ...) are skipped. If your folder holds several programs, narrow the `vscwclang.sourceGlobs` setting, because all matching files are linked into one program (two `main` functions will fail to link). Errors and warnings appear in the Problems panel at the right file, line and column.
- **Build and Run** (`vscwClang: Build and Run C++`): builds, then runs the program in a VS Code terminal. The terminal supports line-by-line input, so programs can read from `std::cin` or `stdin`.
- **Flags**: the `vscwclang.flags` setting (default `-I/workspace`, your project root) is added to every Build and Run, e.g. `-std=c++20` or `-DNAME=1`.
- **Tasks**: a `vscwclang` task type with a matching problem matcher, so builds can run from `tasks.json` with `sources`, `flags`, `mode` (`debug` or `release`) and `output` settings.

Open the Command Palette (`F1`) and type `vscwClang` to find the commands. You need a folder open in the workspace.

## First use

The first build downloads the compiler and the C++ standard library (about 98 MB, from a CDN) and caches them in the extension's storage. After that it works offline. The first build in a session also takes several seconds while the compiler loads.

The extension requires the [WebAssembly Execution Engine](https://marketplace.visualstudio.com/items?itemName=ms-vscode.wasm-wasi-core) extension, which VS Code installs automatically.

## Limitations

This is an early release.

- **WebAssembly only.** Programs are built for `wasm32-wasip1` (WASI) and run in the browser. They can use the C and C++ standard libraries, but not operating-system APIs such as sockets, processes or graphics, and not native libraries.
- **Restricted compiler flags.** Flags that would break the sandbox are rejected with a suggestion, for example `--target`, `-march`, `-o`, `-c`, `-fplugin`, `-fuse-ld`, `--sysroot`, `-B`, and include or library paths outside your workspace. `-I`, `-D`, `-std`, `-O`, `-W...`, `-l`, `-L` and `-Wl,...` work. `--no-gc-sections` is rejected too, because it makes programs hang in the current runtime.
- **No threads yet.** Programs are single-threaded, and the compiler runs one file at a time.
- **No C++ exceptions.** Code is compiled with `-fno-exceptions`.
- **Terminal input has no end-of-file key.** A program that reads until EOF waits until you press Ctrl+C.
- **A crashing program can hang its terminal** instead of reporting the crash. Ctrl+C stops it.
- **No debugger yet.** Breakpoints and stepping are planned but not implemented.
- **No code completion or IntelliSense.** This extension builds and runs code; it doesn't provide language features.

## Licenses

vscwClang is under the Apache License v2.0 with LLVM Exceptions, the same license as Clang. See `LICENSE` and `THIRD_PARTY_NOTICES.md`. The downloaded toolchain is built from the LLVM Project and the wasi-libc and libc++ libraries.

## For contributors

Build instructions, design notes and the remaining work are in [DEV_README.md](https://github.com/Ambeco/vscwClang/blob/main/DEV_README.md).
