# Notes

- 2026-10-02: scaffold from the VS Code web-extension template (esbuild, mocha via `@vscode/test-web`); Hello World replaced by command + debug adapter + toolchain stubs. `check-types`, `lint` and `node esbuild.js` pass.
- Binaries currently live at `llvm-project/built-snapshot/{clang,lld}.wasm` (114 MB / 68 MB); `lldb.wasm`/reactor are not in the snapshot.
- Combining many large heredocs in one Bash call failed to parse here; use the Write tool for doc files.
