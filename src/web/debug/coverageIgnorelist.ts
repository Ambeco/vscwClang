/**
 * Coverage ignorelist for debug builds: no guards in the C++ standard library.
 *
 * A coverage ignorelist matches a function's mangled name (`fun:`) or the module's own source file (`src:`), never the
 * header a template came from, so library code is excluded by name. Without it every `std::vector` call is a stop and
 * costs a hook; the `_ZZ` entries cover lambdas and local classes inside library functions. A user type specialising a
 * `std` template (`std::hash<Mine>`) loses its guards too.
 */
export const COVERAGE_IGNORELIST_FILE = 'vscwclang-coverage-ignore.txt';

export const COVERAGE_IGNORELIST = [
	'fun:_ZNSt*', 'fun:_ZNKSt*', 'fun:_ZNVSt*', 'fun:_ZSt*', 'fun:_ZZNSt*', 'fun:_ZZNKSt*', 'fun:_ZZSt*', 'fun:_ZN9__gnu_cxx*', 'fun:_ZNK9__gnu_cxx*',
].join('\n') + '\n';
