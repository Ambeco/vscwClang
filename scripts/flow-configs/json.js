const CFG = {
  name: 'json', src: 'C:/Users/mooin/vsclang-compat/json',
  include: '^(single_include/|tests/thirdparty/(doctest|fifo_map)/|tests/src/(unit[.]cpp|unit-conversions1[.]cpp|[^/]*[.]hpp)$)', exclude: null,
  extra: { 'stubs/doctest.h': { file: 'C:/Users/mooin/vsclang-compat/cfg/json/doctest.h' }, 'stubs/doctest_compatibility.h': { file: 'C:/Users/mooin/vsclang-compat/cfg/json/doctest_compatibility.h' }, 'stubs/test_data.hpp': '#define TEST_DATA_DIRECTORY "/workspace/test_files"\n' },
  settings: {
    'vscwclang.flags': ['-I/workspace/stubs', '-I/workspace/single_include', '-I/workspace/tests/thirdparty/doctest', '-I/workspace/tests/thirdparty/fifo_map', '-I/workspace/tests/src', '-DDOCTEST_CONFIG_SUPER_FAST_ASSERTS', '-DJSON_TEST_KEEP_MACROS', '-DJSON_TEST_USING_MULTIPLE_HEADERS=0', '-Wno-deprecated-declarations', '-D_WASI_EMULATED_SIGNAL', '-lwasi-emulated-signal', '-Wl,-z,stack-size=8388608'],
    'vscwclang.sourceGlobs': ['tests/src/unit.cpp', 'tests/src/unit-conversions1.cpp'],
  },
  open: 'tests/src/unit-conversions1.cpp', prependBad: '#include <nlohmann/json.hpp>\nnlohmann::json vscw_j;\nint vscw_bad = "oops";\n', hoverTok: 'json', defTab: 'json[.]hpp',
  leaf: 'tests/src/unit-conversions1.cpp', leafSnippet: '\nint vscw_extra_N() { return N; }\n', header: 'single_include/nlohmann/json.hpp', runs: 3, timeoutMs: 60000, settleMs: 20000,
};
