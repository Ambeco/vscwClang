#include <wasi/api.h>

extern void vscw_debug_abort(void) __attribute__((weak));

/* Mirrors the abort shim the extension links (toolchain.ts), which the fixture build does not add. */
void abort(void) {
  if (vscw_debug_abort) {
    vscw_debug_abort();
  }
  __wasi_proc_exit(134);
}

void fail(int depth) {
  if (depth > 0) {
    fail(depth - 1);
  } else {
    abort();
  }
}

int main(void) {
  fail(2);
  return 0;
}
