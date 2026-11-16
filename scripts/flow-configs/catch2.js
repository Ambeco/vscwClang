const CFG = {
  name: 'catch2', src: 'C:/Users/mooin/vsclang-compat/catch2',
  include: '^src/', exclude: null,
  extra: {
    'stubs/catch2/catch_user_config.hpp': { file: 'C:/Users/mooin/vsclang-compat/cfg/catch2/generated-includes/catch2/catch_user_config.hpp' },
    // Named so Ctrl+P does not match catch_main.cpp. Matcher-heavy tests make it the slowest unit, as a real test file would be; it is listed last.
    'vscw_bigtest.cpp': '#include <catch2/catch_all.hpp>\n#include <string>\n#include <vector>\n' + Array.from({ length: 80 }, (_, i) => `TEST_CASE("t${i}") { std::vector<int> v{1, 2, 3, ${i}}; std::string s = "abc${i}"; REQUIRE_THAT(s, Catch::Matchers::ContainsSubstring("bc")); REQUIRE_THAT(v, Catch::Matchers::Contains(2)); REQUIRE_THAT(1.0 * ${i}, Catch::Matchers::WithinAbs(${i}.0, 0.1)); REQUIRE(v.size() == 4); }\n`).join(''),
  },
  settings: {
    'vscwclang.flags': ['-I/workspace/src', '-I/workspace/stubs', '-D_WASI_EMULATED_SIGNAL', '-DCATCH_CONFIG_NO_POSIX_SIGNALS', '-lwasi-emulated-signal'],
    'vscwclang.sourceGlobs': ['src/catch2/**/*.cpp', 'vscw_bigtest.cpp'],
  },
  open: 'vscw_bigtest.cpp', prependBad: '#include <catch2/catch_all.hpp>\nCatch::Approx vscw_a(1.0);\nint vscw_bad = "oops";\n', hoverTok: 'Approx', defTab: 'catch_approx[.]hpp',
  // leaf = the heavy vscw_bigtest.cpp; header = a base header nearly every library unit includes, so an edit recompiles ~60-100 units (pool ordering).
  leaf: 'vscw_bigtest.cpp', leafSnippet: '\nint vscw_extra_N() { return N; }\n', header: 'src/catch2/internal/catch_compiler_capabilities.hpp', runs: 2, timeoutMs: 300000, settleMs: 20000, clearCache: true,
};
