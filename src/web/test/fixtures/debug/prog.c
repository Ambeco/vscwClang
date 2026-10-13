struct P { int x, y; };

int add(int a, int b) {
  int c = a + b;
  if (c > 100)
    c = 0;
  return c;
}

int caller(int x) {
  struct P p = { x, 2 };
  int y = add(p.x, p.y + 8);
  if (y > 100)
    y = 0;
  return y;
}

int main(void) {
  return caller(1);
}
