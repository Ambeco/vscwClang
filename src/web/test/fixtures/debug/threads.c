#include <pthread.h>
#include <stdio.h>

static int result;

int work(int n) {
  int doubled = n * 2;
  return doubled + 1;
}

void *worker(void *arg) {
  int base = *(int *)arg;
  result = work(base);
  return 0;
}

int main(void) {
  int base = 20;
  pthread_t t;
  pthread_create(&t, 0, worker, &base);
  pthread_join(t, 0);
  printf("result=%d\n", result);
  return result == 41 ? 0 : 1;
}
