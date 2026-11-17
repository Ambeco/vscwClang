# Dev loop

- Node tests find the toolchain via `src/web/test/artifacts.ts`: `VSCWCLANG_ARTIFACTS`, else `./llvm-artifacts`, else the newest `../../llvm-project/release/<tag>`. The browser suite needs `llvm-artifacts/mtdist`, which can be a junction to the publish repo's `mtdist` (the only published layout; the single-threaded `dist` layout was removed).
- `npm run test-node` runs the fast, vscode-free tests (`*.node.test.ts`). `npm test` runs the in-browser suite under `@vscode/test-web`: it opens a visible Chromium window, needs `llvm-artifacts/` locally, and builds `llvm-artifacts/mtdist` first if it is missing. Port 3000 must be free.
- `npm run package-web` makes the production bundle; `npx @vscode/vsce package --no-dependencies` makes the VSIX. The extension is browser-only and cannot run on desktop VS Code (see `documents/notes.md`).
- Wasmer host tests: `npm install @wasmer/sdk` in a scratch folder outside the repo, set `VSCWCLANG_WASMER_SDK=<that folder>` for the real-SDK node tests, and copy its `dist/`, `pkg/` and `LICENSE` to `llvm-artifacts/wasmer-sdk/` for `wasmerHost.test.ts` (both skip when missing). `npm test`'s `pretest` needs `llvm-artifacts/MANIFEST`; otherwise run `npm run compile-web` (check it really rebuilt) and `npx vscode-test-web --browserType=chromium --coi --extensionDevelopmentPath=. --extensionTestsPath=dist/web/test/suite/extensionTests.js src/web/test/fixtures/workspace`.
- Real vscode.dev CAN be driven from a session: a Chrome with a dedicated profile on debugging port 9333 plus `scripts/live-driver.cjs` (clicks, typing, screenshots, console log). Setup, driver API and gotchas are in `documents/live_testing.md` "Harness"; read it before saying something "needs a live check" or "needs the user". The profile (permissions, installed extension, cached toolchain) is `~/.claude/chrome-test-profile` (see the temp-cache registry). Quick manual alternative: serve the repo with `npx serve --cors -l 5000`, then "Developer: Install Extension from Location..." (reload the tab after rebuilding).

# Compiler experiments

- Fast loop: run `llvm-artifacts/bin/clang.wasm` / `lld.wasm` under Node `node:wasi` with preopens `/sysroot`, `/resource` (`resource/lib/clang/24`) and the project dir as `/workspace`. In Git Bash set `MSYS_NO_PATHCONV=1`, or `/workspace/...` arguments are rewritten to Windows paths.
- After editing `src/web/debug/debugStub.c`, rebuild the stub fixtures: `MSYS_NO_PATHCONV=1 node scripts/build-debug-fixtures.mjs --release ../../llvm-project/release/<newest tag>`. `llvm-project` is a sibling of the outer working folder (`Github\llvm-project`), whose `build` holds the wasm tools (all multithreaded).
- Never time clang with `-ftime-report` in the browser; it is about 10x slower there (clock reads). Use the per-file `compiled ... in N ms` lines in the `vscwclang` output channel.

# Gotchas

- In Bash heredocs a double backslash arrives as one: write regexes and escape sequences with the Edit/Write tools, not shell-embedded Python or JS. Several files here are CRLF; normalize in Python before multi-line replacements.
- Never regenerate `mtdist/` for an already-pinned toolchain tag: zips embed timestamps and change the manifest hash, which breaks every installed pin. A new tag likewise changes every chunk hash, so publish by keeping the old zips for unchanged files and merging the manifest (`documents/notes.md` "Toolchain build and publishing"). See `documents/remaining_work.md` "Publishing a new toolchain version".
- The shipped `clang`, `lld`, `clangd` and lldb reactor are the PGO + ThinLTO builds from `llvm-project/pgo/*-variant.bat` (binaries kept in `C:\Users\mooin\pgo\variants\keep`), not what `build*.bat` produce (MinSizeRel, slower). Stage the PGO binaries and pass `make-toolchain-dist.mjs --llvm <staging>`; never publish straight from the `build*` trees.
- Check `documents/design.md` "Scope" before adding features; the project is deliberately narrow.
- Before touching host code, mounts, environment variables or working directories, read `documents/design_environments.md` "Three environments" and check the change against the extension host, the tool guests and the user-program guests separately.
- The git repo root is the nested `vsclang\vsclang` folder, not the outer working directory. Glob results are prefixed `vsclang\`, so paths built from the outer directory double up (`...\vsclang\vsclang\vsclang\...`); `cd` into the repo (or use absolute paths) before running git or npm.

# Remaining work upkeep

- Before every commit, scan `documents/remaining_work.md` for items the change finished or touched: delete finished items whole (line plus child bullets), and never append "done"/"verified"/"live-checked" status to an item. A note worth keeping goes in `documents/notes.md`.

# Code map and helpers

- A reusable exported function/class gets `@helper` in its JSDoc and a line in `documents/helpers.md`; `design.md` "Layout" lists the main folders. `npm run test-node` (`codeMap.node.test.ts`) fails with the exact line to add or remove when they drift.
