// Compile/link performance baseline with the extension's real configuration: the threaded tool binaries
// (clang-threads.wasm / lld-threads.wasm, which the dist ships as clang.wasm / lld.wasm), the wasm32-wasip1-threads
// slice, -fintegrated-cc1, the default flags and, for C++, the prebuilt libc++ PCH. Projects come from compat-projects.mjs.
//   node scripts/perf-bench.mjs <projectsDir> <name>[,<name>...] [--only regex] [--repeat 3] [--pch both|on|off]
//        [--link] [--debug] [--out results.json]
// --debug compiles like Debug mode (-O0 -g, trace-pc-guard coverage), links with the debug stub, and times the debugger's
// wasm scan and .debug_line parse on the linked program.
// Per unit it records the median/min/max of --repeat compiles (PCH on and off for C++), then optionally links the
// objects of the selected units. Needs VSCWCLANG_ARTIFACTS (or the newest ../../llvm-project/release/<tag>) and
// llvm-artifacts/dist for the PCH zip. Use Windows-style paths (C:/...) for --out and <projectsDir>.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runWasi } from './clang-wasi.mjs';

const root = resolve(import.meta.dirname, '..');
const { artifactsRoot, artifactResource } = await import('../src/web/test/artifacts.ts');
const { DEFAULT_COMPILE_FLAGS, DEFAULT_C_COMPILE_FLAGS, DEFAULT_LINK_FLAGS } = await import('../src/web/toolchain/defaultFlags.ts');
const artifacts = artifactsRoot();
if (!artifacts) { throw new Error('no toolchain found; set VSCWCLANG_ARTIFACTS to a folder with bin/, sysroot/, resource/ and compile-flags.json'); }
const SLICE = 'wasm32-wasip1-threads';
const flagsJson = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
const DEBUG_FLAGS = ['-O0', '-g', '-fsanitize-coverage=trace-pc-guard,no-prune', ...(flagsJson.debugCoverage ?? [])];
const COMPILE = flagsJson.compile[SLICE].map(sub);
const LINK = flagsJson.link[SLICE].map(sub);

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) { return dflt; } const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = name => { const i = argv.indexOf(name); if (i < 0) { return false; } argv.splice(i, 1); return true; };
const outFile = opt('--out', undefined);
const only = opt('--only', undefined);
const repeat = Number(opt('--repeat', '3'));
const pchMode = opt('--pch', 'both');
const doLink = flag('--link');
const debug = flag('--debug');
const [projectsDir, names] = argv;
if (!projectsDir || !names) { throw new Error('usage: node scripts/perf-bench.mjs <projectsDir> <name>[,<name>...] [--only regex] [--repeat 3] [--pch both|on|off] [--link] [--out file]'); }

const bytesOf = {}, moduleOf = {};
const load = async name => { bytesOf[name] ??= readFileSync(join(artifacts, 'bin', name)); return moduleOf[name] ??= await WebAssembly.compile(bytesOf[name]); };
const clang = async (args, preopens) => runWasi(await load('clang-threads.wasm'), [args[0], '-fintegrated-cc1', ...args.slice(1)], preopens, bytesOf['clang-threads.wasm']);
const lld = async (args, preopens) => runWasi(await load('lld-threads.wasm'), args, preopens, bytesOf['lld-threads.wasm']);

/** Extracts the shipped sysroot (it holds `vscwclang/pch.h`) and the gnu++17 threads PCH from the pinned dist into a cache folder outside the repo and Dropbox. */
function shipped() {
	const base = process.env.VSCWCLANG_BENCH_CACHE ?? 'C:/Users/mooin/vsclang-bench-cache';
	const file = 'pch-gnupp17-threads.pch';
	if (!existsSync(join(base, 'pch', file)) || !existsSync(join(base, 'sysroot', 'vscwclang', 'pch.h'))) {
		mkdirSync(join(base, 'pch'), { recursive: true });
		const py = 'import sys,zipfile;[zipfile.ZipFile(sys.argv[1+2*i]).extractall(sys.argv[2+2*i]) for i in range(2)]';
		execFileSync('python', ['-c', py, join(root, 'llvm-artifacts', 'dist', 'sysroot.zip'), base, join(root, 'llvm-artifacts', 'dist', 'pch-gnupp17-threads.zip'), join(base, 'pch')]);
	}
	return { sysroot: join(base, 'sysroot'), pchDir: join(base, 'pch'), file };
}

const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const stats = a => ({ median: Math.round(median(a)), min: Math.round(Math.min(...a)), max: Math.round(Math.max(...a)) });
const firstError = s => (s.split('\n').find(l => /error:/.test(l)) ?? s.split('\n')[0] ?? '').slice(0, 250);

async function benchProject(name, project) {
	const rootDir = join(projectsDir, project.dir);
	const work = join(tmpdir(), `perf-bench-${name}-${process.pid}`);
	rmSync(work, { recursive: true, force: true });
	const stubDir = join(work, 'stubs'), objDir = join(work, 'obj'), outDir = join(work, 'out');
	for (const d of [stubDir, objDir, outDir]) { mkdirSync(d, { recursive: true }); }
	for (const [n, text] of Object.entries(project.stubs ?? {})) { mkdirSync(dirname(join(stubDir, n)), { recursive: true }); writeFileSync(join(stubDir, n), text); }
	for (const [n, from] of Object.entries(project.stubFiles ?? {})) { mkdirSync(dirname(join(stubDir, n)), { recursive: true }); copyFileSync(from, join(stubDir, n)); }
	const ship = shipped();
	const pch = pchMode === 'off' ? undefined : ship;
	const preopens = { '/sysroot': ship.sysroot, '/resource': artifactResource(), '/workspace': rootDir, '/stubs': stubDir, '/obj': objDir, '/out': outDir, ...(pch ? { '/pch': pch.pchDir } : {}) };
	let units = [...project.units(rootDir), ...Object.keys(project.stubs ?? {}).filter(f => /\.(c|cpp)$/.test(f)).map(f => ({ file: f, abs: `/stubs/${f}` }))];
	if (only) { units = units.filter(u => new RegExp(only).test(u.file)); }
	console.log(`== ${name}: ${units.length} units, ${repeat} repeats, slice ${SLICE}, toolchain ${artifacts}`);
	const report = { name, units: [], link: undefined };
	const objects = [];
	for (const [i, u] of units.entries()) {
		const isC = u.file.endsWith('.c');
		const driver = isC ? 'clang' : 'clang++';
		const variants = isC ? [false] : pchMode === 'both' ? [true, false] : [pchMode === 'on'];
		const rec = { file: u.file, ok: true };
		for (const usePch of variants) {
			const times = [];
			for (let r = 0; r < repeat; r++) {
				const args = [driver, ...COMPILE, '-fno-crash-diagnostics', '-fno-color-diagnostics', '-fno-caret-diagnostics', ...DEFAULT_COMPILE_FLAGS, ...(isC ? DEFAULT_C_COMPILE_FLAGS : []), ...(debug ? DEBUG_FLAGS : []),
					...(usePch ? ['-include-pch', `/pch/${pch.file}`, '-fvalidate-ast-input-files-content'] : []), ...project.flags, ...(u.flags ?? []), '-c', u.abs ?? `/workspace/${u.file}`, '-o', '-'];
				const res = await clang(args, preopens);
				if (res.code !== 0) { rec.ok = false; rec.error = firstError(res.stderr); break; }
				if (r === 0 && usePch === variants[variants.length - 1]) { writeFileSync(join(objDir, `${i}.o`), res.stdout); objects[i] = `/obj/${i}.o`; }
				times.push(res.ms);
			}
			if (times.length === repeat) { rec[usePch ? 'pchMs' : 'noPchMs'] = stats(times); }
			else { rec.ok = false; rec.error ??= `${usePch ? 'PCH ' : ''}compile failed`; }
		}
		report.units.push(rec);
		console.log(`  ${rec.ok ? 'ok  ' : 'FAIL'} ${u.file}  ${rec.pchMs ? `pch ${rec.pchMs.median} ms (${rec.pchMs.min}-${rec.pchMs.max})  ` : ''}${rec.noPchMs ? `no-pch ${rec.noPchMs.median} ms (${rec.noPchMs.min}-${rec.noPchMs.max})` : ''}${rec.error ? '  -> ' + rec.error : ''}`);
	}
	if (doLink) {
		const selected = objects.filter(Boolean);
		const times = [];
		let size = 0, error;
		let stub = [];
		if (debug) {
			const r = await clang(['clang', ...COMPILE, ...DEFAULT_COMPILE_FLAGS, '-O2', '-c', '/stubsrc/debugStub.c', '-o', '-'], { ...preopens, '/stubsrc': join(root, 'src', 'web', 'debug') });
			if (r.code !== 0) { throw new Error('debug stub failed to compile: ' + r.stderr.slice(0, 300)); }
			writeFileSync(join(objDir, 'stub.o'), r.stdout);
			stub = ['/obj/stub.o', '--export=__sanitizer_cov_trace_pc_guard'];
		}
		for (let r = 0; r < repeat; r++) {
			const res = await lld(['wasm-ld', LINK[0], ...selected, ...stub, ...DEFAULT_LINK_FLAGS, ...(project.linkFlags ?? []), ...LINK.slice(1), '-o', '/out/a.wasm'], preopens);
			if (res.code !== 0) { error = firstError(res.stderr) || res.stderr.slice(0, 250); break; }
			times.push(res.ms);
			size = statSync(join(outDir, 'a.wasm')).size;
		}
		if (debug && !error) {
			// The debugger modules use TS syntax Node cannot strip (parameter properties), so bundle them first.
			const { build } = await import('esbuild');
			const bundle = join(work, 'debugModules.mjs');
			await build({ stdin: { contents: "export { parseModule, scanProgram } from './src/web/debug/wasmScan.ts'; export { parseLineTable } from './src/web/debug/dwarfLines.ts';", resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', outfile: bundle, logLevel: 'error' });
			const { parseModule, scanProgram, parseLineTable } = await import(pathToFileURL(bundle).href);
			const bytes = new Uint8Array(readFileSync(join(outDir, 'a.wasm')));
			const t = f => { const t0 = performance.now(); const v = f(); return [performance.now() - t0, v]; };
			const med = f => { const ts = []; let v; for (let k = 0; k < repeat; k++) { const [ms, x] = t(f); ts.push(ms); v = x; } return [stats(ts), v]; };
			const [modMs, info] = med(() => parseModule(bytes));
			let scanMs, scan;
			try { [scanMs, scan] = med(() => scanProgram(bytes)); } catch (e) { report.debugAnalysis = { scanProgramError: String(e.message) }; console.log('  debug analysis: scanProgram FAILED: ' + e.message); scan = { guardSites: new Map() }; scanMs = { median: -1 }; }
			const [lineMs, rows] = med(() => parseLineTable(bytes, info.customSections));
			const dbg = [...info.customSections].filter(([n]) => n.startsWith('.debug')).reduce((a, [, r]) => a + r.end - r.start, 0);
			report.debugAnalysis = { ...report.debugAnalysis, debugBytes: dbg, parseModuleMs: modMs, scanProgramMs: scanMs, parseLineTableMs: lineMs, lineRows: rows.length, guards: scan.guardSites.size };
			console.log(`  debug analysis: parseModule ${modMs.median} ms, scanProgram ${scanMs.median} ms, parseLineTable ${lineMs.median} ms (${rows.length} rows), .debug_* ${dbg} bytes`);
		}
		report.link = error ? { objects: selected.length, error } : { objects: selected.length, size, ms: stats(times) };
		console.log(`  link ${selected.length} objects: ${error ? 'FAIL ' + error : `${report.link.ms.median} ms (${report.link.ms.min}-${report.link.ms.max}), ${size} bytes`}`);
	}
	rmSync(work, { recursive: true, force: true });
	return report;
}

const { PROJECTS } = await import('./compat-projects.mjs');
const results = [];
for (const name of names.split(',')) {
	const project = PROJECTS[name];
	if (!project) { throw new Error(`unknown project '${name}'; did you mean one of ${Object.keys(PROJECTS).join(', ')}?`); }
	results.push(await benchProject(name, project));
	if (outFile) { writeFileSync(outFile, JSON.stringify({ toolchain: artifacts, slice: SLICE, repeat, results }, null, 1)); }
}
