#include <pthread.h>
#include <string.h>

static volatile int ready;
static volatile int spin_count;
static volatile int *volatile bad;

void spin_tick(void) {
  spin_count++;
}

static void *spinner(void *arg) {
  (void)arg;
  ready = 1;
  for (;;) {
    spin_tick();
  }
}

void crash_unreachable(int depth) {
  if (depth > 0) {
    crash_unreachable(depth - 1);
  } else {
    __builtin_trap();
  }
}

int crash_oob(void) {
  bad = (volatile int *)0xffffff00u;
  return *bad;
}

static void *crasher(void *arg) {
  (void)arg;
  while (!ready) {
  }
  crash_unreachable(1);
  return 0;
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "main";
  if (!strcmp(mode, "main")) {
    crash_unreachable(2);
  }
  if (!strcmp(mode, "oob")) {
    return crash_oob();
  }
  pthread_t a, b;
  pthread_create(&a, 0, spinner, 0);
  pthread_create(&b, 0, crasher, 0);
  pthread_join(b, 0);
  return 0;
}
