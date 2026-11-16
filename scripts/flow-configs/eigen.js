const CFG = {
  name: 'eigen', src: 'C:/Users/mooin/vsclang-compat/eigen',
  include: '^(Eigen/|test/([^/]*[.](h|inc)|basicstuff[.]cpp)$)', exclude: null,
  settings: {
    'vscwclang.flags': ['-I/workspace', '-I/workspace/test', '-DEIGEN_TEST_PART_1=1', '-DEIGEN_TEST_MAX_SIZE=320', '-Wl,-z,stack-size=8388608'],
    'vscwclang.sourceGlobs': ['test/basicstuff.cpp'],
  },
  open: 'test/basicstuff.cpp', prependBad: '#include <Eigen/Dense>\nEigen::MatrixXd vscw_m;\nint vscw_bad = "oops";\n', hoverTok: 'MatrixXd', defTab: 'Matrix[.]h',
  leaf: 'test/basicstuff.cpp', leafSnippet: '\nint vscw_extra_N() { return N; }\n', header: 'Eigen/src/Core/Matrix.h', runs: 2, timeoutMs: 400000, settleMs: 20000,
};
