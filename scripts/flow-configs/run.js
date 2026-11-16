// Config for scripts/live-flow-run.js: program variants measured for Run startup and Debug launch/step latency.
const STAMP = [
  'static long long vscw_now_ms() { struct timespec t; clock_gettime(CLOCK_REALTIME, &t); return t.tv_sec * 1000LL + t.tv_nsec / 1000000; }',
  'static void vscw_stamp() { long long a = vscw_now_ms(); FILE* f = fopen("/workspace/t_start.txt", "w"); fprintf(f, "%lld", a); fclose(f); }',
].join('\n');
const CFG = {
  name: 'run', runs: 4, debugRuns: 2, steps: 4, timeoutMs: 120000,
  settings: {},
  variants: [
    { name: 'C stdio hello', file: 'main.c', text: `#include <stdio.h>\n#include <time.h>\n${STAMP}\nint main(void) {\n  vscw_stamp();\n  int x = 1;\n  x += 1;\n  x *= 3;\n  x -= 2;\n  x += 5;\n  puts("done");\n  return x == 7 ? 0 : 1;\n}\n` },
    { name: 'C++ iostream + std::thread', file: 'main.cpp', text: `#include <cstdio>\n#include <ctime>\n#include <iostream>\n#include <thread>\n${STAMP}\nint main() {\n  vscw_stamp();\n  int x = 1;\n  std::thread t([&] { x += 1; });\n  t.join();\n  x *= 3;\n  x -= 2;\n  std::cout << "done " << x << std::endl;\n  return x == 4 ? 0 : 1;\n}\n` },
    { name: 'C++ iostream + 8 MB data segment', file: 'main.cpp', text: `#include <cstdio>\n#include <ctime>\n#include <iostream>\n${STAMP}\nstatic char big[8 << 20] = {1, 2, 3};\nint main() {\n  vscw_stamp();\n  int x = big[1];\n  x += 1;\n  x *= 3;\n  x -= 2;\n  std::cout << "done " << x << std::endl;\n  return x == 4 ? 0 : 1;\n}\n` },
  ],
};
