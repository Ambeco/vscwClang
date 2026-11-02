// Times clangd's cold preamble and AST build per file under Node WASI with the shipped threaded clangd.wasm, via
// `clangd --check=<file>` (it also probes completion/hover, whose timings are logged but not summarized here).
//   node scripts/perf-clangd.mjs <projectsDir> <name> [--only regex] [--limit N] [--repeat 1]
// Needs VSCWCLANG_ARTIFACTS (sysroot, resource) and clangd.wasm in $VSCWCLANG_BENCH_CACHE/clangd (extract dist/clangd.zip there).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runWasi } from './clang-wasi.mjs';

const { artifactsRoot, artifactResource } = await import('../src/web/test/artifacts.ts');
const { DEFAULT_COMPILE_FLAGS } = await import('../src/web/toolchain/defaultFlags.ts');
const artifacts = artifactsRoot();
const cache = process.env.VSCWCLANG_BENCH_CACHE ?? 'C:/Users/mooin/vsclang-bench-cache';
const flagsJson = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
const COMPILE = flagsJson.compile['wasm32-wasip1-threads'].map(sub);
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) { return d; } const v = argv[i + 1]; argv.splice(i, 2); return v; };
const only = opt('--only'), limit = Number(opt('--limit', '5')), repeat = Number(opt('--repeat', '1'));
const [projectsDir, name] = argv;
const { PROJECTS } = await import('./compat-projects.mjs');
const project = PROJECTS[name];
const rootDir = join(projectsDir, project.dir);
let units = project.units(rootDir).filter(u => !only || new RegExp(only).test(u.file)).slice(0, limit);
const bytes = readFileSync(join(cache, process.env.CLANGD_DIR ?? 'clangd', 'clangd.wasm'));
const module = await WebAssembly.compile(bytes);
const work = join(tmpdir(), `perf-clangd-${process.pid}`);
rmSync(work, { recursive: true, force: true });
for (const d of ['cfg', 'tmp']) { mkdirSync(join(work, d), { recursive: true }); }
const stubDir = join(work, 'stubs'); mkdirSync(stubDir);
for (const [n, text] of Object.entries(project.stubs ?? {})) { writeFileSync(join(stubDir, n), text); }
const db = units.map(u => ({ directory: '/workspace', file: `/workspace/${u.file}`, arguments: [u.file.endsWith('.c') ? 'clang' : 'clang++', ...COMPILE, ...DEFAULT_COMPILE_FLAGS, ...project.flags, ...(u.flags ?? []), `/workspace/${u.file}`] }));
writeFileSync(join(work, 'cfg', 'compile_commands.json'), JSON.stringify(db));
if (process.env.PERF_CLANGD_CONFIG) { // clangd config.yaml text, read from XDG_CONFIG_HOME=/cfg
	mkdirSync(join(work, 'cfg', 'clangd'), { recursive: true });
	writeFileSync(join(work, 'cfg', 'clangd', 'config.yaml'), process.env.PERF_CLANGD_CONFIG);
	process.env.VSCWCLANG_WASI_ENV = JSON.stringify({ XDG_CONFIG_HOME: '/cfg' });
}
const preopens = { '/sysroot': join(cache, 'sysroot'), '/resource': artifactResource(), '/workspace': rootDir, '/stubs': stubDir, '/cfg': join(work, 'cfg'), '/tmp': join(work, 'tmp') };
for (const u of units) {
	for (let r = 0; r < repeat; r++) {
		const res = await runWasi(module, ['clangd', `--check=/workspace/${u.file}`, '--compile-commands-dir=/cfg', '-resource-dir=/resource', '-log=verbose', '-background-index=false', '-check-locations=false', ...(process.env.PERF_CLANGD_ARGS?.split(' ') ?? [])], preopens, bytes);
		const text = res.stderr;
		const t = re => { const m = text.match(re); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : undefined; };
		const ts = re => t(new RegExp(String.raw`[IV]\[(\d+):(\d+):([\d.]+)\] ` + re));
		const preamble = text.match(/Built preamble of size (\d+).* in ([\d.]+) seconds/);
		const ast = ts('Indexing AST\.\.\.') - ts('Building AST\.\.\.');
		console.log(`${u.file}: total ${Math.round(res.ms)} ms, exit ${res.code}; preamble ${preamble ? `${preamble[2]} s (${Math.round(preamble[1] / 1024)} KiB)` : '?'}; AST ${Number.isFinite(ast) ? ast.toFixed(2) + ' s' : '?'}`);
		if (r === 0 && process.env.PERF_CLANGD_DUMP) { writeFileSync(join(cache, 'results', `clangd-${u.file.replace(/\W/g, '_')}.log`), text); }
	}
}
rmSync(work, { recursive: true, force: true });
