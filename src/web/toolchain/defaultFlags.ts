/**
 * Flags every build gets before the user's, so porting common C/C++ needs no flags (user flags still win, being later).
 *
 * Signal, getpid and process-clock emulation headers are opt-in in wasi-libc (mmap is left out on purpose: its emulation
 * silently drops writes). setjmp/longjmp needs the sjlj lowering, applied to C only (tested with C; C++ keeps wasm EH).
 * The stack is 8 MiB because the default overflows in template-heavy code and reports only an out-of-bounds trap.
 * The precompiled headers are built with the same compile defines (scripts/make-toolchain-dist.mjs).
 */
export const DEFAULT_COMPILE_FLAGS = ['-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_GETPID', '-D_WASI_EMULATED_PROCESS_CLOCKS'];
export const DEFAULT_C_COMPILE_FLAGS = ['-mllvm', '-wasm-enable-sjlj'];
export const DEFAULT_LINK_FLAGS = ['-lwasi-emulated-signal', '-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks', '-lsetjmp', '-z', 'stack-size=8388608'];
