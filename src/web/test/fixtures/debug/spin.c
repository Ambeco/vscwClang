static volatile int counter;

void tick(void) {
  counter++;
}

int main(void) {
  for (;;) {
    tick();
  }
}
