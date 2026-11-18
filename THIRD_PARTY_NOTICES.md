# Third-party notices

## fflate (bundled in the extension)

Used to unzip the downloaded toolchain. MIT License:

MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Downloaded toolchain (not part of this package)

On first use the extension downloads, from https://github.com/Ambeco/llvm-artifacts, WebAssembly builds of
Clang and LLD (from the LLVM Project) and a WASI sysroot (wasi-libc, libc++, libc++abi, compiler-rt builtins).
The LLVM Project and libc++ are under the Apache License v2.0 with LLVM Exceptions; wasi-libc is under several
permissive licenses (Apache-2.0 WITH LLVM-exception, MIT, BSD). See each project's `LICENSE` file for the exact terms.

## Downloaded Make pack (not part of this package)

When a Make command is first used, the extension downloads `make.wasm`, GNU make 4.4.1 built for WebAssembly, from
https://github.com/Ambeco/llvm-artifacts. GNU make is under the GNU General Public License v3.0 or later. Its
corresponding source is the pinned upstream tarball (https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz, SHA-256
`dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3`) plus `scripts/build-make-wasm.mjs` and
`scripts/make-wasm/` in this repository (two source edits, a generated `config.h` and WASI compatibility shims).
The binary is never part of this package.

## Test fixtures (not part of this package)

`src/web/test/fixtures/ninja/linux-gtest` and `linux-gtest-discover` are unmodified
`build.ninja` and `CMakeFiles/rules.ninja` files that CMake generated and their authors committed, used only as test
input: Gabriel-ino/ArgParse-Cpp (Copyright (c) 2022 Gabriel Chaves) and FacundoSalcovich/Wordle (Copyright (c) 2025
FacuSalco). Each is under the MIT License: permission is granted, free
of charge, to use, copy, modify, merge, publish, distribute, sublicense and sell copies, provided the copyright
notice and this permission notice are included; the software is provided "as is", without warranty of any kind.
