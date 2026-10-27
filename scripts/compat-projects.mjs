// Project definitions for compat-survey.mjs. `units(root)` lists translation units relative to the project root.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const walk = (root, sub, re, skip = () => false) => {
	const out = [];
	const rec = dir => {
		for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
			const p = dir ? `${dir}/${e.name}` : e.name;
			if (e.isDirectory()) { rec(p); } else if (re.test(e.name) && !skip(p)) { out.push(p); }
		}
	};
	rec(sub);
	return out.sort();
};
const list = (root, dir, re, skip) => walk(root, dir, re, skip).map(file => ({ file }));

export const PROJECTS = {
	lua: {
		dir: 'lua',
		flags: ['-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-DLUA_TMPNAMBUFSIZE=32', '-Dlua_tmpnam(b,e)=(e=1)', '-mllvm', '-wasm-enable-sjlj'],
		linkFlags: ['-lsetjmp', '-lwasi-emulated-signal', '-lwasi-emulated-process-clocks'],
		units: root => list(root, '', /\.c$/, p => p.includes('/') || ['lua.c', 'luac.c', 'ltests.c', 'onelua.c'].includes(p)).concat([{ file: 'lua.c' }]),
		stubs: { 'vscw_stubs.c': ['#include <stdio.h>', '#include <stdlib.h>', 'FILE *tmpfile(void) { return NULL; }', 'int system(const char *c) { return c ? -1 : 0; }', ''].join('\n') },
		links: [{ name: 'lua', output: 'lua.wasm' }],
		runs: [
			{ name: 'hello', output: 'lua.wasm', args: ['-e', 'print("hello", _VERSION, 1+1)'], expect: (c, o) => c === 0 && o.includes('hello	Lua 5.5	2') },
			{ name: 'pcall/error (setjmp)', output: 'lua.wasm', args: ['-e', 'local ok, e = pcall(function() error("boom") end); print(ok, e)'], expect: (c, o) => c === 0 && o.includes('false	') && o.includes('boom') },
			{ name: 'coroutines+gc+string', output: 'lua.wasm', args: ['-e', 'local co = coroutine.wrap(function() for i = 1, 3 do coroutine.yield(i) end end); local t = {}; for i = 1, 3 do t[#t + 1] = co() end; collectgarbage(); print(table.concat(t, ","), ("x"):rep(3), string.format("%5.2f", math.pi))'], expect: (c, o) => c === 0 && o.includes('1,2,3	xxx	 3.14') },
			{ name: 'fib(30) timing', output: 'lua.wasm', args: ['-e', 'local function f(n) if n < 2 then return n end return f(n-1) + f(n-2) end print(f(30))'], expect: (c, o) => c === 0 && o.includes('832040') },
			{ name: 'io.open write/read', output: 'lua.wasm', args: ['-e', 'local f = assert(io.open("/tmp/x.txt", "w")); f:write("abc"); f:close(); print(io.open("/tmp/x.txt"):read("a"))'], expect: (c, o) => c === 0 && o.includes('abc') },
		],	},
	sqlite: {
		dir: 'sqlite/sqlite-amalgamation-3540100',
		flags: ['-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_MMAN', '-D_WASI_EMULATED_GETPID', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-DSQLITE_THREADSAFE=0', '-DSQLITE_OMIT_LOAD_EXTENSION', '-DSQLITE_NOHAVE_SYSTEM'],
		linkFlags: ['-lwasi-emulated-signal', '-lwasi-emulated-mman', '-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks'],
		units: () => [{ file: 'sqlite3.c' }, { file: 'shell.c' }],
		links: [{ name: 'sqlite3', output: 'sqlite3.wasm' }],
		runs: [
			{ name: 'version', output: 'sqlite3.wasm', args: [':memory:', 'select sqlite_version();'], expect: (c, o) => c === 0 && /^3\.54/.test(o) },
			{ name: 'create/insert/query (file db in /tmp)', output: 'sqlite3.wasm', args: ['/tmp/t.db', 'create table t(a integer primary key, b text); insert into t(b) select hex(randomblob(8)) from generate_series(1,1000); select count(*), sum(a) from t;'], expect: (c, o) => c === 0 && o.trim() === '1000|500500' },
			{ name: 'memory db, json + window fn', output: 'sqlite3.wasm', args: [':memory:', "select json_extract('{\"a\":[1,2,3]}', '$.a[1]'), sum(x) over (order by x) from (select 1 x union all select 2) order by 1;"], expect: (c, o) => c === 0 && o.includes('2|1') },
		],
	},
	json: {
		dir: 'json',
		flags: ['-I/stubs', '-I/workspace/single_include', '-I/workspace/tests/thirdparty/doctest', '-I/workspace/tests/thirdparty/fifo_map', '-I/workspace/tests/src', '-DDOCTEST_CONFIG_SUPER_FAST_ASSERTS', '-DJSON_TEST_KEEP_MACROS', '-DJSON_TEST_USING_MULTIPLE_HEADERS=0', '-Wno-deprecated-declarations',  '-D_WASI_EMULATED_SIGNAL'],
		linkFlags: ['-lwasi-emulated-signal', '-z', 'stack-size=8388608'],
		stubFiles: { 'doctest.h': 'C:/Users/mooin/vsclang-compat/cfg/json/doctest.h', 'doctest_compatibility.h': 'C:/Users/mooin/vsclang-compat/cfg/json/doctest_compatibility.h' },
		stubs: { 'test_data.hpp': '#define TEST_DATA_DIRECTORY "/workspace/test_files"\n' },
		units: root => list(root, 'tests/src', /^unit.*\.cpp$/),
		links: ['unit-conversions', 'unit-regression1', 'unit-json_pointer', 'unit-unicode1', 'unit-class_parser'].map(n => ({ name: n, output: `${n}.wasm`, select: f => f.endsWith('/unit.cpp') || f.endsWith(`/${n}.cpp`) })),
		runs: ['unit-conversions', 'unit-regression1', 'unit-json_pointer', 'unit-unicode1', 'unit-class_parser'].map(n => ({ name: n, output: `${n}.wasm`, args: [], expect: (c, o) => /test cases:/.test(o) && c === 0 })),
	},
	catch2: {
		dir: 'catch2',
		flags: ['-I/workspace/src', '-I/stubs', '-I/workspace/tests/SelfTest', '-D_WASI_EMULATED_SIGNAL', '-DCATCH_CONFIG_NO_POSIX_SIGNALS'],
		linkFlags: ['-lwasi-emulated-signal'],
		stubFiles: { 'catch2/catch_user_config.hpp': 'C:/Users/mooin/vsclang-compat/cfg/catch2/generated-includes/catch2/catch_user_config.hpp' },
		units: root => [...list(root, 'src/catch2', /\.cpp$/), ...list(root, 'tests/SelfTest', /\.cpp$/, p => p.includes('Sleep.tests'))],
		links: [{ name: 'SelfTest', output: 'SelfTest.wasm' }],
		runs: [{ name: 'SelfTest (default filter)', output: 'SelfTest.wasm', args: ['~[!nonportable]~[!benchmark]~[approvals]'], timeout: 300000, expect: (c, o) => /test cases:|All tests passed/.test(o) }],
	},
	fmt: {
		dir: 'fmt',
		flags: ['-I/workspace/include', '-I/workspace/test/gtest', '-I/workspace/test', '-DGTEST_HAS_STD_WSTRING=1', '-DGTEST_HAS_PTHREAD=0', '-D_WASI_EMULATED_SIGNAL', '-Dmkstemp(t)=(-1)'],
		linkFlags: ['-lwasi-emulated-signal'],
		units: () => ['src/format.cc', 'src/os.cc', 'test/gtest/gmock-gtest-all.cc', 'test/test-main.cc', 'test/gtest-extra.cc', 'test/util.cc',
			'args-test', 'core-test', 'assert-test', 'chrono-test', 'color-test', 'enum-test', 'gtest-extra-test', 'format-test', 'ostream-test', 'compile-test', 'printf-test', 'ranges-test', 'ranges-odr-test', 'std-test', 'xchar-test', 'scan-test', 'unicode-test', 'no-builtin-types-test', 'format-impl-test', 'header-only-test', 'enforce-checks-test']
			.map(f => ({ file: f.includes('/') ? f : `test/${f}.cc`, flags: f === 'enforce-checks-test' ? ['-DFMT_ENFORCE_COMPILE_STRING'] : ['format-impl-test', 'header-only-test'].includes(f) ? ['-DFMT_HEADER_ONLY'] : [] })),
		links: ['core-test', 'ostream-test', 'printf-test', 'chrono-test', 'ranges-test', 'args-test'].map(n => ({ name: n, output: `${n}.wasm`, select: f => ['src/format.cc', 'src/os.cc', 'test/gtest/gmock-gtest-all.cc', 'test/test-main.cc', 'test/gtest-extra.cc', 'test/util.cc', `test/${n}.cc`, ...(n === 'ranges-test' ? ['test/ranges-odr-test.cc'] : [])].includes(f) })),
		runs: ['core-test', 'ostream-test', 'printf-test', 'chrono-test', 'ranges-test', 'args-test'].map(n => ({ name: n, output: `${n}.wasm`, args: [], timeout: 120000, expect: (c, o) => /PASSED|tests ran/.test(o) && c === 0 })),
	},
	eigen: {
		dir: 'eigen',
		linkFlags: ['-z', 'stack-size=8388608'],
		flags: ['-I/workspace', '-I/workspace/test', '-DEIGEN_TEST_PART_1=1', '-DEIGEN_TEST_MAX_SIZE=320'],
		stubs: { 'demo.cpp': ['#include <Eigen/Dense>', '#include <Eigen/Sparse>', '#include <Eigen/Geometry>', '#include <iostream>', 'int main() {', '  Eigen::MatrixXd a = Eigen::MatrixXd::Random(50, 50); Eigen::VectorXd b = Eigen::VectorXd::Ones(50);', '  Eigen::VectorXd x = a.colPivHouseholderQr().solve(b);', '  Eigen::JacobiSVD<Eigen::MatrixXd> svd(a);', '  Eigen::SelfAdjointEigenSolver<Eigen::MatrixXd> es(a + a.transpose());', '  Eigen::SparseMatrix<double> s(3, 3); s.insert(0, 0) = 2; s.insert(1, 1) = 3; s.insert(2, 2) = 4; Eigen::SimplicialLDLT<Eigen::SparseMatrix<double>> ldlt(s);', '  Eigen::Quaterniond q(Eigen::AngleAxisd(0.5, Eigen::Vector3d::UnitZ()));', '  std::cout << "residual " << ((a * x - b).norm() < 1e-8) << " sigma0>0 " << (svd.singularValues()(0) > 0) << " ev " << es.eigenvalues().size() << " sparse " << ldlt.solve(Eigen::Vector3d(2, 3, 4)).transpose() << " q " << q.w() << std::endl;', '}', ''].join('\n') },
		units: () => [
			{ file: 'test/basicstuff.cpp' },
			{ file: 'test/adjoint.cpp' },
			{ file: 'test/cholesky.cpp' },
			{ file: 'test/geo_transformations.cpp' },
			{ file: 'test/product_small.cpp' },
			{ file: 'test/eigensolver_selfadjoint.cpp' },
			{ file: 'test/jacobisvd.cpp' },
			{ file: 'test/array_cwise.cpp' },
			{ file: 'test/lu.cpp' },
			{ file: 'test/sparse_basic.cpp' },
			{ file: 'test/sparse_product.cpp' },
		],
		links: [{ name: 'demo', output: 'demo.wasm', select: f => f === 'demo.cpp' }, { name: 'basicstuff', output: 'basicstuff.wasm', select: f => f === 'test/basicstuff.cpp' },{ name: 'adjoint', output: 'adjoint.wasm', select: f => f === 'test/adjoint.cpp' },{ name: 'cholesky', output: 'cholesky.wasm', select: f => f === 'test/cholesky.cpp' },{ name: 'geo_transformations', output: 'geo_transformations.wasm', select: f => f === 'test/geo_transformations.cpp' },{ name: 'product_small', output: 'product_small.wasm', select: f => f === 'test/product_small.cpp' },{ name: 'eigensolver_selfadjoint', output: 'eigensolver_selfadjoint.wasm', select: f => f === 'test/eigensolver_selfadjoint.cpp' },{ name: 'jacobisvd', output: 'jacobisvd.wasm', select: f => f === 'test/jacobisvd.cpp' },{ name: 'array_cwise', output: 'array_cwise.wasm', select: f => f === 'test/array_cwise.cpp' },{ name: 'lu', output: 'lu.wasm', select: f => f === 'test/lu.cpp' },{ name: 'sparse_basic', output: 'sparse_basic.wasm', select: f => f === 'test/sparse_basic.cpp' },{ name: 'sparse_product', output: 'sparse_product.wasm', select: f => f === 'test/sparse_product.cpp' }],
		runs: [{ name: 'demo', output: 'demo.wasm', args: [], expect: (c, o) => c === 0 && o.includes('residual 1') }, { name: 'basicstuff', output: 'basicstuff.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'adjoint', output: 'adjoint.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'cholesky', output: 'cholesky.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'geo_transformations', output: 'geo_transformations.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'product_small', output: 'product_small.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'eigensolver_selfadjoint', output: 'eigensolver_selfadjoint.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'jacobisvd', output: 'jacobisvd.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'array_cwise', output: 'array_cwise.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'lu', output: 'lu.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'sparse_basic', output: 'sparse_basic.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 },{ name: 'sparse_product', output: 'sparse_product.wasm', args: ['r1', 's1'], timeout: 300000, expect: (c, o, e) => c === 0 }],
	},
};
