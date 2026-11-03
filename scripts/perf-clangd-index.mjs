// Times clangd's background indexer on a compat project under Node WASI with the threaded clangd.wasm.
//   node scripts/perf-clangd-index.mjs <projectsDir> <name> [--j 4] [--only regex] [--limit N] [--timeout 600] [--flags "-x -y"]
// clangd needs a stdin pipe, so the parent re-launches itself as a `--guest` child with piped stdin, sends a minimal LSP
// handshake, then polls the index shard directory (`/workspace/build` and `/workspace/.cache` are shadowed by empty dirs so a project's own compile_commands.json is ignored and nothing is written into it) (the extension's overlay route: didChangeConfiguration compilationDatabaseChanges) until every unit has a shard. Prints the time from `initialized` to the
// last unit's shard. Needs VSCWCLANG_ARTIFACTS (sysroot, resource) and clangd.wasm in $VSCWCLANG_BENCH_CACHE/$CLANGD_DIR
// (default `clangd`). PERF_CLANGD_CONFIG is written as clangd's config.yaml (XDG_CONFIG_HOME=/cfg).
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, openSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) { return d; } const v = argv[i + 1]; argv.splice(i, 2); return v; };
const cache = process.env.VSCWCLANG_BENCH_CACHE ?? 'C:/Users/mooin/vsclang-bench-cache';
const clangdPath = join(cache, process.env.CLANGD_DIR ?? 'clangd', 'clangd.wasm');

if (argv[0] === '--guest') {
	const { runWasi } = await import('./clang-wasi.mjs');
	const { artifactResource } = await import('../src/web/test/artifacts.ts');
	const [, work, rootDir, jobs] = argv;
	const bytes = readFileSync(clangdPath);
	const module = await WebAssembly.compile(bytes);
	const preopens = { '/sysroot': join(cache, 'sysroot'), '/resource': artifactResource(), '/workspace': rootDir, '/stubs': join(work, 'stubs'), '/cfg': join(work, 'cfg'), '/cache': join(work, 'shards'), '/pch': join(cache, 'pch'), '/workspace/build': join(work, 'nobuild'), '/workspace/.cache': join(work, 'wscache'), '/tmp': join(work, 'tmp') };
	const args = ['clangd', '-resource-dir=/resource', '-log=info', '-background-index', `-j=${jobs}`, ...(process.env.PERF_CLANGD_ARGS?.split(' ').filter(Boolean) ?? [])];
	const r = await runWasi(module, args, preopens, bytes, { stdinFd: 0 });
	writeFileSync(join(work, 'guest.log'), `exit ${r.code}\n${r.stderr}`);
	process.exit(0);
}

const { artifactsRoot } = await import('../src/web/test/artifacts.ts');
const { DEFAULT_COMPILE_FLAGS } = await import('../src/web/toolchain/defaultFlags.ts');
const { PROJECTS } = await import('./compat-projects.mjs');
const artifacts = artifactsRoot();
const flagsJson = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
const COMPILE = flagsJson.compile['wasm32-wasip1-threads'].map(sub);
const jobs = Number(opt('--j', '4')), only = opt('--only'), limit = Number(opt('--limit', '1000')), timeoutS = Number(opt('--timeout', '600'));
const extra = (opt('--flags', '') ?? '').split(' ').filter(Boolean);
const [projectsDir, name] = argv;
const project = PROJECTS[name];
const rootDir = join(projectsDir, project.dir);
const units = project.units(rootDir).filter(u => !only || new RegExp(only).test(u.file)).slice(0, limit);

const work = join(tmpdir(), `perf-clangd-index-${process.pid}`);
rmSync(work, { recursive: true, force: true });
for (const d of ['cfg', 'tmp', 'stubs', 'shards', 'nobuild', 'wscache']) { mkdirSync(join(work, d), { recursive: true }); }
for (const [n, text] of Object.entries(project.stubs ?? {})) { writeFileSync(join(work, 'stubs', n), text); }
const db = units.map(u => ({ directory: '/workspace', file: `/workspace/${u.file}`, arguments: [u.file.endsWith('.c') ? 'clang' : 'clang++', ...COMPILE, ...DEFAULT_COMPILE_FLAGS, ...project.flags, ...(u.flags ?? []), ...extra, `/workspace/${u.file}`] }));
const changes = Object.fromEntries(db.map(e => [e.file, { workingDirectory: e.directory, compilationCommand: e.arguments }]));
if (process.env.PERF_CLANGD_CONFIG) {
	mkdirSync(join(work, 'cfg', 'clangd'), { recursive: true });
	writeFileSync(join(work, 'cfg', 'clangd', 'config.yaml'), process.env.PERF_CLANGD_CONFIG);
}
process.env.VSCWCLANG_WASI_ENV = JSON.stringify({ XDG_CACHE_HOME: '/cache', ...(process.env.PERF_CLANGD_CONFIG ? { XDG_CONFIG_HOME: '/cfg' } : {}) });

const child = spawn(process.execPath, ['--no-warnings', import.meta.filename, '--guest', work, rootDir, String(jobs)], { stdio: ['pipe', 'ignore', 'inherit'], env: process.env });
const send = msg => { const body = JSON.stringify({ jsonrpc: '2.0', ...msg }); child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
send({ id: 1, method: 'initialize', params: { processId: null, rootUri: 'file:///workspace', capabilities: { window: { workDoneProgress: true } } } });
await new Promise(r => setTimeout(r, 1500));
const started = performance.now();
send({ method: 'initialized', params: {} });
const names = Object.keys(changes);
for (let i = 0; i < names.length; i += 200) { send({ method: 'workspace/didChangeConfiguration', params: { settings: { compilationDatabaseChanges: Object.fromEntries(names.slice(i, i + 200).map(n => [n, changes[n]])) } } }); }

const shardDir = join(work, 'shards', 'clangd', 'index');
const wanted = new Set(units.map(u => basename(u.file)));
let done = 0;
for (;;) {
	await new Promise(r => setTimeout(r, 200));
	const have = existsSync(shardDir) ? readdirSync(shardDir).map(f => f.replace(/\.[0-9A-F]+\.idx$/i, '')) : [];
	const covered = new Set(have.filter(n => wanted.has(n)));
	done = covered.size;
	const elapsed = (performance.now() - started) / 1000;
	if (done >= wanted.size) { console.log(`${name}: ${units.length} units, -j ${jobs}: indexed in ${elapsed.toFixed(1)} s (${have.length} shards)`); break; }
	if (elapsed > timeoutS) { console.log(`${name}: TIMEOUT after ${timeoutS} s, ${done}/${wanted.size} units indexed`); break; }
}
send({ id: 2, method: 'shutdown' });
send({ method: 'exit' });
await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 8000))]);
child.kill();
if (process.env.PERF_CLANGD_LOG && existsSync(join(work, 'guest.log'))) { console.log(readFileSync(join(work, 'guest.log'), 'utf8').split(String.fromCharCode(10)).filter(l => !l.startsWith('V[')).slice(-40).join(String.fromCharCode(10))); }
if (process.env.PERF_CLANGD_KEEP) { console.log(`work dir kept: ${work}`); } else { await new Promise(r => setTimeout(r, 500)); rmSync(work, { recursive: true, force: true }); }
process.exit(0);
