#include <stdio.h>

int square(int x) {
  fprintf(stderr, "in square\n");
  return x * x;
}

int main(void) {
  int n = 0;
  printf("enter: ");
  fflush(stdout);
  if (scanf("%d", &n) != 1) return 99;
  fprintf(stderr, "got %d\n", n);
  int r = square(n);
  printf("result %d\n", r);
  return r > 255 ? 1 : r;
}
