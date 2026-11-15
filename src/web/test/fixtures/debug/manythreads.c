#include <pthread.h>
#include <stdint.h>
#include <stdio.h>

static int total;

int bump(int n) {
  return n + 1;
}

static void *worker(void *arg) {
  __atomic_fetch_add(&total, bump((int)(intptr_t)arg), __ATOMIC_SEQ_CST);
  return 0;
}

void all_joined(void) {
}

int main(void) {
  for (int i = 0; i < 100; i++) {
    pthread_t t;
    pthread_create(&t, 0, worker, (void *)(intptr_t)i);
    pthread_join(t, 0);
  }
  all_joined();
  printf("total=%d\n", total);
  return total == 5050 ? 0 : 1;
}
