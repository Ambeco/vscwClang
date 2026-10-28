struct P { int x, y; };
struct Big { double d; char tag[8]; struct P p; };

static int leaf(int q) {
  return q + 1;
}

static int shadow(int n) {
  int v = n * 2;
  {
    int v2 = v + 1;
    {
      int v = v2 + 100;
      n += v;
    }
    n += v2;
  }
  return n + v;
}

static double mixed(double d, char *s, struct P pv, struct Big *bp, long long ll, unsigned char uc) {
  int arr[4] = { 1, 2, 3, 4 };
  struct Big local = { d, "abc", pv };
  float f = 2.5f;
  int total = 0;
  for (int i = 0; i < 4; i++)
    total += arr[i];
  total += s[0] + bp->p.x + (int)ll + uc + local.p.y + (int)f;
  return total + d;
}

static int vla(int n) {
  int buf[n];
  int sum = 0;
  for (int i = 0; i < n; i++) { buf[i] = i * 3; sum += buf[i]; }
  return sum;
}

int main(void) {
  struct Big big = { 9.5, "big", { 7, 8 } };
  struct P pv = { 3, 4 };
  int r = leaf(1) + shadow(5);
  r += (int)mixed(1.5, "hey", pv, &big, 123456789012LL, 200);
  r += vla(4);
  return r > 0 ? 0 : 1;
}
