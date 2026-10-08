# vscwClang

C and C++ in Visual Studio Code for Web: compile and run with Clang, entirely in your browser, with nothing installed.

vscwClang runs WebAssembly builds of Clang and LLD inside the extension, so on vscode.dev or github.dev you can build and run C/C++ code with no local compiler, no remote machine and no server. Everything happens in your browser tab; your code never leaves it.

> **Unofficial.** vscwClang is an independent project. It is not affiliated with or endorsed by the LLVM Project, the LLVM Foundation, or Microsoft.

## What it does

- **Build** (`vscwClang: Build C++`): compiles every `.c`, `.cc`, `.cpp` and `.cxx` file in your workspace and links them into `a.out.wasm` under `.vscwclang/<mode>/` (`release` or `debug`) in your folder, next to a `build.log`. For read-only or virtual folders (such as GitHub repositories opened on vscode.dev) these go to the extension's storage instead, so those still build and run. You may want to add `.vscwclang/` to `.gitignore`. IDE scratch and build-output folders (`Debug`, `x64`, `build`, `enc_temp_folder`, `.vs`, ...) are skipped. If your folder holds several programs, narrow the `vscwclang.sourceGlobs` setting, because all matching files are linked into one program (two `main` functions will fail to link). Errors and warnings appear in the Problems panel at the right file, line and column.
- **Build and Run** (`vscwClang: Build and Run C++`): builds, then runs the program in a VS Code terminal. The terminal supports line-by-line input, so programs can read from `std::cin` or `stdin`: type the input into the terminal, where it is echoed beside the output. **Build and Run with Arguments...** asks for command-line arguments first (remembered per workspace); the `vscwclang.run.args` setting gives fixed ones. Your folder is mounted at `/workspace`, and relative paths such as `input.txt` start there too.
- **Flags**: the `vscwclang.flags` setting (default `-I/workspace`, your project root) is added to every Build and Run, e.g. `-std=c++20` or `-DNAME=1`.
- **Your existing `tasks.json` and `launch.json`**: if the default build task (`group: { kind: build, isDefault: true }`) runs `g++`, `gcc`, `clang++` or `clang` (as the C/C++ extension's `C/C++: g++ build active file` does), Build uses its source files, `-I`/`-D`/`-std`/`-O`/`-l` flags and `-o` name instead of the `vscwclang.*` settings; `${file}`, `${fileDirname}`, `${workspaceFolder}` and the other file variables work (`${input:}`, `${command:}` and `${env:}` do not). Run takes `args` from a `cppdbg`, `cppvsdbg`, `lldb` or `codelldb` launch configuration (a picker appears when there are several) and builds with its `preLaunchTask`, so it replaces the arguments prompt; `vscwClang: Build and Run with Arguments...` still asks, pre-filled from it. Flags a browser cannot honour (`-pthread`, `-static`, colour flags) are dropped and listed in the `vscwclang` output; forbidden ones (`-c`, `--target`) are errors. Tasks that run `make`, `cmake` or `cl.exe` are ignored (a note appears in the output). `shell` tasks are mapped by the commands only; `cppbuild` tasks also run from the Tasks menu. `program` and `cwd` are not used: Run always runs what it just built, and relative paths start at `/workspace`.
- **`compile_commands.json` and `compile_flags.txt`**: with no default `tasks.json` build task, Build and Run use `compile_commands.json` (workspace root or `build/`, or the `vscwclang.compileCommands` setting), as written by CMake (`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`) or Bear. Each source is compiled with the flags of its own entry; a CMake database with several targets asks which target to build (like CMake Tools), and `vscwclang.compileCommands.include` narrows other databases. Paths made on another machine are mapped onto your folder; include directories outside it are dropped with a note. A `compile_flags.txt` supplies flags for all sources. The compiler must be g++/gcc/clang (optionally behind `ccache`); response files (`@x.rsp`) are not supported.
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
- **No C++ exceptions.** Code is compiled with `-fno-exceptions`, so `throw`, `try` and `catch` are compile errors.
- **32-bit target.** WebAssembly here is `wasm32`: pointers, `size_t` and `uintptr_t` are 32 bits. Code that assumes 64-bit pointers (size assertions, pointer-tagging) needs changes.
- **No Windows APIs.** `windows.h`, `winsock2.h` and MSVC-only functions such as `_stricmp` and `strcpy_s` are not available.
- **Terminal input has no end-of-file key.** A program that reads until EOF waits until you press Ctrl+C.
- **Crashes.** A failed `assert`, `abort()` or `std::terminate` ends the program with `exited with code 134 (aborted)`. Other crashes (out-of-bounds memory access, division by zero, stack overflow) leave the terminal waiting with no message until you press Ctrl+C, because the WebAssembly runtime doesn't report them.
- **No debugger yet.** Breakpoints and stepping are planned but not implemented.
- **No code completion or IntelliSense.** This extension builds and runs code; it doesn't provide language features.

## What your program can see

Programs run in a sandbox: they can read and write files in your workspace folder, use stdin and stdout, read the clock and random numbers. `HOME` is `/home/user` (kept between runs), `TMPDIR` is `/tmp` (emptied before each run); both are writable and live in the extension's storage. `USER` and `LANG` are set too, and the `vscwclang.run.env` setting adds or removes variables. There is no network and no other programs (`system()` and `popen` don't work, `fork` doesn't exist). `mmap` of a file can read it, but writes through a shared mapping are not saved.

## Licenses

vscwClang is under the Apache License v2.0 with LLVM Exceptions, the same license as Clang. See `LICENSE` and `THIRD_PARTY_NOTICES.md`. The downloaded toolchain is built from the LLVM Project and the wasi-libc and libc++ libraries.

## For contributors

Build instructions, design notes and the remaining work are in [DEV_README.md](https://github.com/Ambeco/vscwClang/blob/main/DEV_README.md).
