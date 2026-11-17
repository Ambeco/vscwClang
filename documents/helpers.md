# Helpers

Registry of reusable helpers: exported functions, classes or consts whose JSDoc block contains `@helper`. Check here (then grep) before writing a new one.

Tree format: folders end in `/`, files have an extension, names sit below their file (`*` matches any run of characters), two spaces per level, ` # text` is a comment. `src/web/test/suite/codeMap.node.test.ts` (run by `npm run test-node`) fails when a tagged helper has no entry, an entry has no tagged helper, or this file passes 150 lines, and the failure names the line to add or remove.

```
src/web/
  buildgraph/
    classify.ts
      classifyShellLine        # shell line -> BuildAction[] (compile, link, archive, file ops)
    graph.ts
      BuildGraph               # actions as nodes, edges from files read/written
    shellParse.ts
      parseShellLine           # one shell line -> simple commands, throws on unsupported syntax
  clangd/
    clippedLog.ts
      ClippedLog               # batched, line-clipped output-channel writer
    tidySeverity.ts
      raiseTidyHints           # clang-tidy Hints -> Warnings so they reach Problems
  host/
    cachingGuestFs.ts
      CachingGuestFs           # shared read cache, validated by stat
    rpcStats.ts
      RpcStats                 # per-op file-request totals
    sharedMemory.ts
      createSharedMemory       # imported shared memory of a wasi-threads module
    workspaceSync.ts
      skipDefaultFolders       # .git, node_modules, .vscwclang
  projectConfig.ts
    projectSettings            # settings read per workspace folder
    isUserSet                  # user value vs extension default
  toolchain/
    concurrency.ts
      forEachLimited           # bounded-parallel loop
      longestFirst             # job order by last duration
    chunkedFile.ts
      readChunked
    guestPaths.ts              # host path <-> /workspace guest path
      toGuestPath
      fromGuestPath
      stripWorkspaceFolder
      isToolchainGuestPath     # /sysroot and /resource
    diagnostics.ts
      isSameReport             # build vs clangd Problems
    projectModel.ts
      resolveVariables         # ${...} expansion shared by tasks, launch and settings
      programStem
      hostToGuest              # compile_commands paths from any machine
    runEnvironment.ts
      splitArgs                # shell-style quoting
      joinArgs
    sourceFilter.ts
      makeSourceExcluder       # files.exclude globs
      outputFolderExclude      # exclude globs for folders with CMake/Ninja marker files
    threadSlice.ts
      chooseSlice              # wasip1 vs wasip1-threads
    toolchainDownload.ts
      sha256Hex
```
