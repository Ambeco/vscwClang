Lists the compile probes and process spawns a CMake project makes at configure time (C2 spike, `documents/design_cmake.md`).

1. Make `cc.cmd`, `c++.cmd` and `ar.cmd` next to `toolchain.cmake` (Windows: `@node <this dir>/wrap.js %*`); they log every call to `$C2LOG` (absolute path) and fake success.
2. `cmake -S <project> -B <out> -G Ninja -DCMAKE_TOOLCHAIN_FILE=<this dir>/toolchain.cmake --trace-expand --trace-format=json-v1 --trace-redirect=<trace.json>`
3. `node probes.cjs <trace.json>` prints each `try_compile`, `check_*`, `execute_process`, `find_package` and `ExternalProject_*` call.

Probe results are all faked successes, so only the list of probes is meaningful, not their outcome. Only `cxx_std_NN` and `c_std_NN` features are seeded.
