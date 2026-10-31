int sq(int x) {
  int y = x * x;
  return y;
}

int main(void) {
  int total = 0;
  for (int i = 0; i < 5; i++) {
    total += sq(i);
  }
  return total;
}
