/*
 * In-process debug stub for "debug" builds: the debuggee's half of the control channel (see stubChannel.ts).
 *
 * Compile this file WITHOUT -fsanitize-coverage and link it into a program built with
 * `-O0 -g -fsanitize-coverage=trace-pc-guard`. The compiler calls __sanitizer_cov_trace_pc_guard on every basic
 * block; this file is that hook, so the program pauses without any custom host import.
 *
 * Wire format: stub -> host on stderr as ESC _ vscw <text> ESC \ (the program's own stderr passes through around
 * it); host -> stub as text lines on stdin, read ONE byte at a time so no byte meant for the program is swallowed.
 * The host only writes commands while the program is stopped here, so the two uses of stdin never overlap, except
 * for program input written just before a stop: such a line (one not starting with "vscw ") is sent back as an
 * `input` frame instead of being treated as a command.
 *
 * Threads (all-stop): the shadow stack and step state are per thread (`_Thread_local`; each thread has its own
 * `__stack_pointer`), and stops are served one at a time in arrival order (a ticket lock). A stop sets CTL_STOPPED in
 * `control`; every other thread parks at its next hook (`memory.atomic.wait32` on `resume_gen`) and falls through to
 * its own breakpoint check when the world resumes, so a breakpoint it sat on still fires. Each thread registers in
 * `registry` at its first hook, so the host lists every thread and reads a parked thread's shadow stack straight from
 * shared memory (layout: ThreadInfo below). A thread blocked in a lock, sleep or `cin`, or inside uninstrumented
 * code, does not reach a hook: a stop waits a short while for it, then reports it as running. Every stop frame names
 * its thread.
 */
#include <pthread.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#define MAX_FRAMES 2048
#define MAX_ARMED 512
#define MAX_MEM_READ 8192
#define MAX_THREADS 64
/* How long a stop waits for threads that have not been seen blocked to park: WAIT_SLICES * 20 ms. */
#define WAIT_SLICES 2

typedef struct { uint32_t *guard; uintptr_t sp; } Frame;

/* The host reads these in shared memory: 5 little-endian words per thread after the leading count. */
typedef struct { uint32_t id; int32_t tid; uint32_t frames; uint32_t depth; uint32_t state; } ThreadInfo;
/* TS_PARKED waits in park() for a resume; TS_QUEUED has hit a stop point and waits its turn to report it. The host treats both as stopped. */
enum { TS_FREE, TS_RUNNING, TS_PARKED, TS_DEAD, TS_QUEUED };
enum { CTL_PAUSE = 1, CTL_STOPPED = 2 };

static _Thread_local Frame frames[MAX_FRAMES];
static _Thread_local uint32_t depth;
static uint32_t *armed[MAX_ARMED];
static uint32_t armed_count;
static int detached; /* host closed stdin: never stop again */
/* The host sets CTL_PAUSE through shared memory (the address is in `hello`); the first hook to see it stops with "pause". */
static uint32_t control;
static uint32_t resume_gen; /* bumped on every resume; parked threads wait on it */
static uint32_t activity;   /* bumped when a thread parks, resumes or exits; a stop waits on it */
static struct { uint32_t count; ThreadInfo threads[MAX_THREADS]; } registry;
static ThreadInfo overflow_info; /* for threads beyond MAX_THREADS: they stop but are not listed */
static uint8_t laggard[MAX_THREADS]; /* per registry slot: a stop timed out waiting for this thread; kept out of the registry so the host's layout is unchanged */
static pthread_key_t exit_key;
enum { STEP_NONE, STEP_INTO, STEP_OVER, STEP_OUT };
static _Thread_local int step_mode;
static _Thread_local uintptr_t step_sp;
static uint32_t ticket_next, ticket_serving;
static uint32_t next_thread_id = 1;
static _Thread_local ThreadInfo *self_info; /* id 1 is the thread that runs the startup hook, then in order of first hook */

#ifdef __wasm_atomics__
#define WAIT32(addr, expected, ns) __builtin_wasm_memory_atomic_wait32((int *)(addr), (int)(expected), (ns))
#define NOTIFY_ALL(addr) __builtin_wasm_memory_atomic_notify((int *)(addr), UINT32_MAX)
#else
/* No atomics feature, so no other threads exist: nothing ever parks or waits. */
#define WAIT32(addr, expected, ns) 0
#define NOTIFY_ALL(addr) 0
#endif

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

static void note_activity(void) {
  __atomic_fetch_add(&activity, 1, __ATOMIC_SEQ_CST);
  NOTIFY_ALL(&activity);
}

/* Runs when a thread exits (a pthread key destructor), so the host stops listing it. */
static void thread_exited(void *info) {
  __atomic_store_n(&((ThreadInfo *)info)->state, TS_DEAD, __ATOMIC_SEQ_CST);
  note_activity();
}

/* Takes a slot for the calling thread: a dead thread's slot is reused, so many short-lived threads fit. */
static void register_thread(void) {
  ThreadInfo *slot = 0;
  uint32_t count = __atomic_load_n(&registry.count, __ATOMIC_SEQ_CST);
  for (uint32_t i = 0; i < count && !slot; i++) {
    uint32_t dead = TS_DEAD;
    if (__atomic_compare_exchange_n(&registry.threads[i].state, &dead, TS_RUNNING, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) slot = &registry.threads[i];
  }
  if (!slot) {
    uint32_t i = __atomic_fetch_add(&registry.count, 1, __ATOMIC_SEQ_CST);
    if (i < MAX_THREADS) slot = &registry.threads[i];
    else { __atomic_fetch_sub(&registry.count, 1, __ATOMIC_SEQ_CST); slot = &overflow_info; }
  }
  if (slot != &overflow_info) laggard[slot - registry.threads] = 0;
  slot->id = __atomic_fetch_add(&next_thread_id, 1, __ATOMIC_SEQ_CST);
  slot->frames = (uint32_t)(uintptr_t)frames;
  slot->depth = (uint32_t)(uintptr_t)&depth;
  __atomic_store_n(&slot->state, TS_RUNNING, __ATOMIC_SEQ_CST);
  self_info = slot;
  if (slot != &overflow_info) pthread_setspecific(exit_key, slot);
}

/* How many other threads are still running user code, and how many of those are not known laggards. */
static void count_runners(uint32_t *running, uint32_t *fresh) {
  uint32_t count = __atomic_load_n(&registry.count, __ATOMIC_SEQ_CST);
  *running = *fresh = 0;
  for (uint32_t i = 0; i < count; i++) {
    if (&registry.threads[i] == self_info || __atomic_load_n(&registry.threads[i].state, __ATOMIC_SEQ_CST) != TS_RUNNING) continue;
    (*running)++;
    if (!laggard[i]) (*fresh)++;
  }
}

/*
 * Gives the other threads a moment to reach a hook and park. One that does not (blocked in a lock, sleep or join,
 * or in uninstrumented code) is reported as running and remembered as a laggard until it next parks, so later stops
 * wait only ~1 ms for it instead of the full time: a program with main in join() would otherwise pay it on every
 * internal stop (false conditions, logpoints, step repeats).
 */
static void wait_for_others(void) {
  for (int slice = 0; slice < WAIT_SLICES; slice++) {
    uint32_t running, fresh;
    count_runners(&running, &fresh);
    if (!running) return;
    uint32_t seen = __atomic_load_n(&activity, __ATOMIC_SEQ_CST);
    WAIT32(&activity, seen, (fresh ? 20 : 1) * 1000 * 1000LL);
    if (!fresh) break;
  }
  uint32_t count = __atomic_load_n(&registry.count, __ATOMIC_SEQ_CST);
  for (uint32_t i = 0; i < count; i++) {
    if (&registry.threads[i] != self_info && __atomic_load_n(&registry.threads[i].state, __ATOMIC_SEQ_CST) == TS_RUNNING) laggard[i] = 1;
  }
}

/* Called by a thread that finds the world stopped: parks until the stopping thread resumes it. */
static void park(void) {
  if (self_info != &overflow_info) laggard[self_info - registry.threads] = 0;
  __atomic_store_n(&self_info->state, TS_PARKED, __ATOMIC_SEQ_CST);
  note_activity();
  for (;;) {
    uint32_t gen = __atomic_load_n(&resume_gen, __ATOMIC_SEQ_CST);
    if (!(__atomic_load_n(&control, __ATOMIC_SEQ_CST) & CTL_STOPPED)) break;
    WAIT32(&resume_gen, gen, -1);
  }
  __atomic_store_n(&self_info->state, TS_RUNNING, __ATOMIC_SEQ_CST);
  note_activity();
}

static int none_parked(void) {
  uint32_t count = __atomic_load_n(&registry.count, __ATOMIC_SEQ_CST);
  for (uint32_t i = 0; i < count; i++) {
    if (__atomic_load_n(&registry.threads[i].state, __ATOMIC_SEQ_CST) == TS_PARKED) return 0;
  }
  return 1;
}

/* After a resume, lets the parked threads run past their hook before this one does, so a breakpoint this thread hits again at once cannot starve them. */
static void wait_for_wake(void) {
  for (int slice = 0; slice < WAIT_SLICES && !none_parked(); slice++) {
    uint32_t seen = __atomic_load_n(&activity, __ATOMIC_SEQ_CST);
    if (none_parked()) break;
    WAIT32(&activity, seen, 20 * 1000 * 1000LL);
  }
}

__attribute__((noinline)) static void stop(const char *reason) {
  /* Counts as stopped while it waits its turn, so the thread being served does not wait for this one. */
  __atomic_store_n(&self_info->state, TS_QUEUED, __ATOMIC_SEQ_CST);
  note_activity();
  uint32_t mine = __atomic_fetch_add(&ticket_next, 1, __ATOMIC_SEQ_CST);
  for (;;) {
    uint32_t serving = __atomic_load_n(&ticket_serving, __ATOMIC_SEQ_CST);
    if (serving == mine) break;
    WAIT32(&ticket_serving, serving, -1);
  }
  /* Any stop satisfies a pending pause; otherwise it would fire again right after the resume. */
  __atomic_fetch_and(&control, ~(uint32_t)CTL_PAUSE, __ATOMIC_SEQ_CST);
  __atomic_fetch_or(&control, CTL_STOPPED, __ATOMIC_SEQ_CST);
  wait_for_others();
  out_begin("stop"); out_str(reason); out_str(" "); out_num(self_info->id); out_str(" "); out_num(depth);
  for (uint32_t i = depth; i-- > 0;) { out_str(" "); out_num((uintptr_t)frames[i].guard); out_str(" "); out_num(frames[i].sp); }
  out_end();
  command_loop();
  __atomic_fetch_and(&control, ~(uint32_t)CTL_STOPPED, __ATOMIC_SEQ_CST);
  __atomic_fetch_add(&resume_gen, 1, __ATOMIC_SEQ_CST);
  NOTIFY_ALL(&resume_gen);
  __atomic_store_n(&self_info->state, TS_RUNNING, __ATOMIC_SEQ_CST);
  note_activity();
  wait_for_wake();
  __atomic_fetch_add(&ticket_serving, 1, __ATOMIC_SEQ_CST);
  NOTIFY_ALL(&ticket_serving);
}

void __sanitizer_cov_trace_pc_guard_init(uint32_t *start, uint32_t *end) {
  static int announced;
  if (announced) return;
  announced = 1;
  pthread_key_create(&exit_key, thread_exited);
  register_thread();
  out_begin("hello"); out_num((uintptr_t)start); out_str(" "); out_num((uintptr_t)end); out_str(" "); out_num((uintptr_t)&control);
  out_str(" "); out_num((uintptr_t)&registry); out_str(" "); out_num(MAX_THREADS); out_end();
  command_loop();
}

void __sanitizer_cov_trace_pc_guard(uint32_t *guard) {
  if (detached) return;
  uintptr_t sp = get_sp();
  while (depth && frames[depth - 1].sp < sp) depth--;
  if (depth && frames[depth - 1].sp == sp) frames[depth - 1].guard = guard;
  else if (depth < MAX_FRAMES) { frames[depth].guard = guard; frames[depth].sp = sp; depth++; }
  if (!self_info) register_thread();
  uint32_t ctl = __atomic_load_n(&control, __ATOMIC_RELAXED);
  if (ctl) {
    /* Parked first, so a thread that sits on a breakpoint while the world is stopped still reports it after the resume. */
    if (ctl & CTL_STOPPED) { park(); ctl = __atomic_load_n(&control, __ATOMIC_RELAXED); }
    if ((ctl & CTL_PAUSE) && (__atomic_fetch_and(&control, ~(uint32_t)CTL_PAUSE, __ATOMIC_SEQ_CST) & CTL_PAUSE)) { stop("pause"); return; }
  }
  if (*guard & 1u) { stop("breakpoint"); return; }
  switch (step_mode) {
    case STEP_INTO: stop("step"); break;
    case STEP_OVER: if (sp >= step_sp) stop("step"); break;
    case STEP_OUT: if (sp > step_sp) stop("step"); break;
  }
}
