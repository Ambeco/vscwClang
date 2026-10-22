/*
 * In-process debug stub for "debug" builds: the debuggee's half of the control channel (see stubChannel.ts).
 *
 * Compile this file WITHOUT -fsanitize-coverage and link it into a program built with
 * `-O0 -g -fsanitize-coverage=trace-pc-guard`. The compiler calls __sanitizer_cov_trace_pc_guard on every basic
 * block; this file is that hook, so wasm-wasi-core (which accepts no custom imports) can still pause the program.
 *
 * Wire format: stub -> host on stderr as ESC _ vscw <text> ESC \ (the program's own stderr passes through around
 * it); host -> stub as text lines on stdin, read ONE byte at a time so no byte meant for the program is swallowed.
 * The host only writes commands while the program is stopped here, so the two uses of stdin never overlap, except
 * for program input written just before a stop: such a line (one not starting with "vscw ") is sent back as an
 * `input` frame instead of being treated as a command.
 */
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#define MAX_FRAMES 2048
#define MAX_ARMED 512
#define MAX_MEM_READ 8192

typedef struct { uint32_t *guard; uintptr_t sp; } Frame;

static Frame frames[MAX_FRAMES];
static uint32_t depth;
static uint32_t *armed[MAX_ARMED];
static uint32_t armed_count;
static int detached; /* host closed stdin: never stop again */
enum { STEP_NONE, STEP_INTO, STEP_OVER, STEP_OUT };
static int step_mode;
static uintptr_t step_sp;

static inline uintptr_t get_sp(void) {
  uintptr_t sp;
  __asm__ volatile("global.get __stack_pointer\n\tlocal.set %0" : "=r"(sp));
  return sp;
}

static void put_all(const char *p, size_t n) {
  while (n) {
    ssize_t w = write(2, p, n);
    if (w <= 0) return;
    p += w;
    n -= (size_t)w;
  }
}

/* One buffer per message so the host sees a whole frame in as few chunks as the pipe allows. */
static char out[MAX_MEM_READ * 2 + 128];
static size_t out_len;

static void out_str(const char *s) { size_t n = strlen(s); memcpy(out + out_len, s, n); out_len += n; }
static void out_num(uintptr_t v) {
  char tmp[12]; int n = 0;
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (n) out[out_len++] = tmp[--n];
}
static void out_begin(const char *kind) { out_len = 0; out_str("\x1b_vscw "); out_str(kind); out_str(" "); }
static void out_end(void) { out_str("\x1b\\"); put_all(out, out_len); }

/* Reads up to a newline or until `buf` is full; *complete says whether the newline was seen. -1 when stdin closed. */
static int read_line(char *buf, size_t cap, int *complete) {
  size_t n = 0;
  *complete = 0;
  for (;;) {
    char c;
    ssize_t r = read(0, &c, 1);
    if (r <= 0) return -1;
    if (c == '\n') { *complete = 1; break; }
    buf[n++] = c;
    if (n + 1 >= cap) break;
  }
  buf[n] = 0;
  return (int)n;
}

static const char *next_token(const char *s, uintptr_t *value) {
  while (*s == ' ') s++;
  if (*s < '0' || *s > '9') return 0;
  uintptr_t v = 0;
  while (*s >= '0' && *s <= '9') v = v * 10 + (uintptr_t)(*s++ - '0');
  *value = v;
  return s;
}

static void send_error(const char *what) { out_begin("error"); out_str(what); out_end(); }

static void set_breakpoints(const char *args) {
  for (uint32_t i = 0; i < armed_count; i++) *armed[i] &= ~1u;
  armed_count = 0;
  uintptr_t addr;
  while ((args = next_token(args, &addr))) {
    if (armed_count == MAX_ARMED) { send_error("too many breakpoints (limit 512); did you mean to set fewer?"); return; }
    armed[armed_count++] = (uint32_t *)addr;
    *(uint32_t *)addr |= 1u;
  }
}

static void send_memory(const char *args) {
  uintptr_t addr, len;
  if (!(args = next_token(args, &addr)) || !next_token(args, &len)) { send_error("usage: mem <addr> <len>"); return; }
  uintptr_t limit = (uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
  if (len > MAX_MEM_READ || addr >= limit || len > limit - addr) {
    out_begin("memerr"); out_num(addr); out_str(" "); out_num(len); out_end();
    return;
  }
  out_begin("mem"); out_num(addr); out_str(" ");
  for (uintptr_t i = 0; i < len; i++) {
    uint8_t b = *(volatile uint8_t *)(addr + i);
    out[out_len++] = "0123456789abcdef"[b >> 4];
    out[out_len++] = "0123456789abcdef"[b & 15];
  }
  out_end();
}

/* Hands bytes the program was meant to read back to the host, which re-sends them after the next resume. */
static void send_input(const char *p, size_t n, int newline) {
  out_begin("input");
  for (size_t i = 0; i < n; i++) {
    uint8_t b = (uint8_t)p[i];
    out[out_len++] = "0123456789abcdef"[b >> 4];
    out[out_len++] = "0123456789abcdef"[b & 15];
  }
  if (newline) { out[out_len++] = '0'; out[out_len++] = 'a'; }
  out_end();
}

/* Serves commands until one resumes the program. */
static void command_loop(void) {
  char line[1100];
  enum { LINE_NEW, LINE_INPUT, LINE_DISCARD } rest = LINE_NEW; /* what an unfinished line's remainder is */
  for (;;) {
    int complete;
    int n = read_line(line, sizeof line, &complete);
    if (n < 0) { detached = 1; step_mode = STEP_NONE; return; }
    int was = rest;
    rest = LINE_NEW;
    /* Program input typed before the program read it (it stopped at a breakpoint first): give it back, in order. */
    if (was == LINE_INPUT || (was == LINE_NEW && strncmp(line, "vscw ", 5) != 0)) {
      send_input(line, (size_t)n, complete);
      if (!complete) rest = LINE_INPUT;
      continue;
    }
    if (was == LINE_DISCARD) { if (!complete) rest = LINE_DISCARD; continue; }
    if (!complete) { send_error("command line too long; did you mean a shorter 'vscw bp' list?"); rest = LINE_DISCARD; continue; }
    if (n && line[n - 1] == '\r') line[--n] = 0;
    const char *cmd = line + 5;
    if (!strcmp(cmd, "sync")) { out_begin("synced"); out_end(); }
    else if (!strncmp(cmd, "bp", 2)) set_breakpoints(cmd + 2);
    else if (!strncmp(cmd, "mem ", 4)) send_memory(cmd + 4);
    else if (!strcmp(cmd, "go")) { step_mode = STEP_NONE; return; }
    else if (!strcmp(cmd, "into")) { step_mode = STEP_INTO; return; }
    else if (!strcmp(cmd, "over")) { step_mode = STEP_OVER; step_sp = depth ? frames[depth - 1].sp : 0; return; }
    else if (!strcmp(cmd, "out")) { step_mode = STEP_OUT; step_sp = depth ? frames[depth - 1].sp : 0; return; }
    else send_error("unknown command; did you mean bp, mem, go, into, over or out?");
  }
}

__attribute__((noinline)) static void stop(const char *reason) {
  out_begin("stop"); out_str(reason); out_str(" "); out_num(depth);
  for (uint32_t i = depth; i-- > 0;) { out_str(" "); out_num((uintptr_t)frames[i].guard); out_str(" "); out_num(frames[i].sp); }
  out_end();
  command_loop();
}

void __sanitizer_cov_trace_pc_guard_init(uint32_t *start, uint32_t *end) {
  static int announced;
  if (announced) return;
  announced = 1;
  out_begin("hello"); out_num((uintptr_t)start); out_str(" "); out_num((uintptr_t)end); out_end();
  command_loop();
}

void __sanitizer_cov_trace_pc_guard(uint32_t *guard) {
  if (detached) return;
  uintptr_t sp = get_sp();
  while (depth && frames[depth - 1].sp < sp) depth--;
  if (depth && frames[depth - 1].sp == sp) frames[depth - 1].guard = guard;
  else if (depth < MAX_FRAMES) { frames[depth].guard = guard; frames[depth].sp = sp; depth++; }
  if (*guard & 1u) { stop("breakpoint"); return; }
  switch (step_mode) {
    case STEP_INTO: stop("step"); break;
    case STEP_OVER: if (sp >= step_sp) stop("step"); break;
    case STEP_OUT: if (sp > step_sp) stop("step"); break;
  }
}
