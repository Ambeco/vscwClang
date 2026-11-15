#include <pthread.h>

static volatile int main_count;
static volatile int thread_count;

void main_tick(void) {
  main_count++;
}

void thread_tick(void) {
  thread_count++;
}

static void *worker(void *arg) {
  (void)arg;
  for (;;) {
    thread_tick();
  }
}

int main(void) {
  pthread_t t;
  pthread_create(&t, 0, worker, 0);
  for (;;) {
    main_tick();
  }
}
