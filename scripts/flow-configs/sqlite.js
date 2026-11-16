const CFG = {
  name: 'sqlite', src: 'C:/Users/mooin/vsclang-compat/sqlite/sqlite-amalgamation-3540100',
  include: '[.](c|h)$', exclude: null,
  settings: {
    'vscwclang.flags': ['-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_MMAN', '-D_WASI_EMULATED_GETPID', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-DSQLITE_THREADSAFE=0', '-DSQLITE_OMIT_LOAD_EXTENSION', '-DSQLITE_NOHAVE_SYSTEM', '-lwasi-emulated-signal', '-lwasi-emulated-mman', '-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks'],
    'vscwclang.sourceGlobs': ['sqlite3.c', 'shell.c'],
  },
  open: 'shell.c', prependBad: '#include "sqlite3.h"\nsqlite3* vscw_db;\nint vscw_bad = "oops";\n', hoverTok: 'sqlite3', defTab: 'sqlite3[.]h',
  leaf: 'shell.c', leafSnippet: '\nint vscw_extra_N(void) { return N; }\n', header: 'sqlite3.h', runs: 3, timeoutMs: 240000, settleMs: 20000,
};
