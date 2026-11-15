#include <pthread.h>

void tick(void) {
}

static void *worker(void *arg) {
  (void)arg;
  for (int i = 0; i < 50; i++) {
    tick();
  }
  return 0;
}

int main(void) {
  pthread_t t;
  pthread_create(&t, 0, worker, 0);
  pthread_join(t, 0);
  return 0;
}
