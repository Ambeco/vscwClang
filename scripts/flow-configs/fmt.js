const CFG = {
  name: 'fmt', src: 'C:/Users/mooin/vsclang-compat/fmt',
  include: '^(include|src|test)/', exclude: '^test/(add-subdirectory-test|compile-error-test|cuda-test|find-package-test|fuzzing|static-export-test)/',
  settings: {
    'vscwclang.flags': ['-I/workspace/include', '-I/workspace/test/gtest', '-I/workspace/test', '-DGTEST_HAS_STD_WSTRING=1', '-DGTEST_HAS_PTHREAD=0', '-D_WASI_EMULATED_SIGNAL', '-Dmkstemp(t)=(-1)', '-lwasi-emulated-signal'],
    'vscwclang.sourceGlobs': ['src/format.cc', 'src/os.cc', 'test/gtest/gmock-gtest-all.cc', 'test/test-main.cc', 'test/gtest-extra.cc', 'test/util.cc', 'test/core-test.cc'],
  },
  open: 'test/core-test.cc', prependBad: '#include "fmt/core.h"\nfmt::appender* vscw_p = nullptr;\nint vscw_bad = "oops";\n', hoverTok: 'appender', defTab: 'core[.]h',
  leaf: 'test/core-test.cc', leafSnippet: '\nint vscw_extra_N() { return N; }\n', header: 'include/fmt/core.h', runs: 3, timeoutMs: 180000, settleMs: 20000,
};
