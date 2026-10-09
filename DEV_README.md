# vscwClang (developer README)

The user-facing README (shown on the Marketplace) is `README.md`; this file is for contributors.

vscwClang is a VS Code for Web extension that compiles, runs and debugs C++ in the browser using WebAssembly builds of Clang, LLD and LLDB.

## 1. Project idea and reason

Let people write and debug real C/C++ in vscode.dev / github.dev with nothing installed, on machines where installing a compiler is impossible or unwanted (Chromebooks, locked-down school or work machines, tablets, a quick change to a repo without a cloud VM). Scope is deliberately narrow: see `documents/design.md` "Scope" before adding features. The toolchain comes from the wasm-wasi LLVM fork (`llvm-project`); this repo is the extension that hosts it. Output is WebAssembly only.

## 2. How to use this project

- `npm install`, then `npm run compile-web` (type-check, lint, bundle).
- `npm run run-in-browser` opens the extension in a local VS Code for Web.
- Status: `vscwclang.build` compiles and links a multi-file C/C++ workspace to `a.out.wasm` in the browser and publishes parsed diagnostics to Problems; `vscwclang.run` builds and runs it in a terminal with interactive stdin; a `vscwclang` task type and `$vscwclang` problem matcher exist (the toolchain is downloaded on first use from jsDelivr (`Ambeco/llvm-artifacts`, pinned by hash) and cached; `vscwclang.toolchainUrl` overrides the host for development; `npm run toolchain-dist` builds a local copy of the hosted layout, and `npx @vscode/vsce package` makes the VSIX). `npm run test-node` runs the pure-logic tests; `npm test` runs the in-browser tests (Chromium, needs `llvm-artifacts/`). Debug is not implemented yet.

## 3. Design overview

See `documents/design.md`.

## 4. Remaining work

See `documents/remaining_work.md`. Briefly: toolchain host and in-browser compile, tasks/run, debug-build instrumentation, lldb reactor integration, full DAP.

Aspirational, unscheduled stretch goal: compile clang itself (and ideally run its test suite) entirely inside this extension in the browser, with nothing installed on the desktop. Unlikely to ever be reached, but it's a useful compass for prioritizing work that scales toward a real compiler over work that only serves toy programs.

## 5. Credits

Designed and overseen by [Ambeco](https://github.com/Ambeco), and coded mostly by Claude (or similar).
