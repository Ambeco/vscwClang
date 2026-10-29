int square(int n) {
  return n * n;
}

int main(void) {
  int total = 0;
  for (int i = 0; i < 6; i++) {
    total += square(i);
  }
  return total;
}
