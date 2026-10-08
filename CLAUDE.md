# Dev loop

- `npm run test-node` runs the fast, vscode-free tests (`*.node.test.ts`). `npm test` runs the in-browser suite under `@vscode/test-web`: it opens a visible Chromium window, needs `llvm-artifacts/` locally, and builds `llvm-artifacts/dist` first if it is missing. Port 3000 must be free.
- `npm run package-web` makes the production bundle; `npx @vscode/vsce package --no-dependencies` makes the VSIX. The extension is browser-only and cannot run on desktop VS Code (see `documents/notes.md`).
- Try a local build on vscode.dev: serve the repo with `npx serve --cors -l 5000`, then "Developer: Install Extension from Location..." (reload the tab after rebuilding).

# Compiler experiments

- Fast loop: run `llvm-artifacts/bin/clang.wasm` / `lld.wasm` under Node `node:wasi` with preopens `/sysroot`, `/resource` (`resource/lib/clang/24`) and the project dir as `/workspace`. In Git Bash set `MSYS_NO_PATHCONV=1`, or `/workspace/...` arguments are rewritten to Windows paths.
- Never time clang with `-ftime-report` in the browser; it is about 10x slower there (clock reads). Use the per-file `compiled ... in N ms` lines in the `vscwclang` output channel.

# Gotchas

- In Bash heredocs a double backslash arrives as one: write regexes and escape sequences with the Edit/Write tools, not shell-embedded Python or JS. Several files here are CRLF; normalize in Python before multi-line replacements.
- Never regenerate `dist/` for an already-pinned toolchain tag: zips may embed timestamps and change the manifest hash, which breaks every installed pin. See `documents/remaining_work.md` "Publishing a new toolchain version".
- Check `documents/design.md` "Scope" before adding features; the project is deliberately narrow.
