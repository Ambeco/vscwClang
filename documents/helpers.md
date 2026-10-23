# Helpers

Registry of reusable helpers: exported functions, classes or consts whose JSDoc block contains `@helper`. Check here (then grep) before writing a new one.

Tree format: folders end in `/`, files have an extension, names sit below their file (`*` matches any run of characters), two spaces per level, ` # text` is a comment. `src/web/test/suite/codeMap.node.test.ts` (run by `npm run test-node`) fails when a tagged helper has no entry, an entry has no tagged helper, or this file passes 150 lines, and the failure names the line to add or remove.

```
src/web/
  projectConfig.ts
    isUserSet                  # user value vs extension default
  toolchain/
    chunkedFile.ts
      readChunked
    guestPaths.ts              # host path <-> /workspace guest path
      toGuestPath
      fromGuestPath
      stripWorkspaceFolder
      isToolchainGuestPath     # /sysroot and /resource
    projectModel.ts
      resolveVariables         # ${...} expansion shared by tasks, launch and settings
      programStem
      hostToGuest              # compile_commands paths from any machine
    runEnvironment.ts
      splitArgs                # shell-style quoting
      joinArgs
    sourceFilter.ts
      makeSourceExcluder       # files.exclude globs
    toolchainDownload.ts
      sha256Hex
```
