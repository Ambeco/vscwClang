// Times clangd's first preamble and the preamble rebuild after a header edit, under Node WASI with the threaded clangd.wasm.
//   node scripts/perf-clangd-edit.mjs [--repeat 3] [--mode header|main|both]
// A scratch project (lib.h includes <string>/<vector>/<map>, main.cpp includes lib.h and <iostream>) is opened over a piped-stdin
// LSP session; the timings come from clangd's own `-log=info` timestamps (preamble built/reused lines).
// Needs VSCWCLANG_ARTIFACTS (resource) and clangd.wasm + sysroot in $VSCWCLANG_BENCH_CACHE.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) { return d; } const v = argv[i + 1]; argv.splice(i, 2); return v; };
const cache = process.env.VSCWCLANG_BENCH_CACHE ?? 'C:/Users/mooin/vsclang-bench-cache';
const clangdPath = join(cache, process.env.CLANGD_DIR ?? 'clangd', 'clangd.wasm');

if (argv[0] === '--guest') {
	const { runWasi } = await import('./clang-wasi.mjs');
	const { artifactResource } = await import('../src/web/test/artifacts.ts');
	const [, work, rootDir] = argv;
	const bytes = readFileSync(clangdPath);
	const module = await WebAssembly.compile(bytes);
	const preopens = { '/sysroot': join(cache, 'sysroot'), '/resource': artifactResource(), '/workspace': rootDir, '/cfg': join(work, 'cfg'), '/cache': join(work, 'cache'), '/tmp': join(work, 'tmp') };
	const args = ['clangd', '-resource-dir=/resource', '-log=info', '-background-index=false', '-check-locations=false', ...(process.env.PERF_CLANGD_ARGS?.split(' ').filter(Boolean) ?? [])];
	const r = await runWasi(module, args, preopens, bytes, { stdinFd: 0 });
	writeFileSync(join(work, 'guest.log'), `exit ${r.code}\n${r.stderr}`);
	process.exit(0);
}

const repeat = Number(opt('--repeat', '1'));
const mode = opt('--mode', 'header');
const { artifactsRoot } = await import('../src/web/test/artifacts.ts');
const { DEFAULT_COMPILE_FLAGS } = await import('../src/web/toolchain/defaultFlags.ts');
const flagsJson = JSON.parse(readFileSync(join(artifactsRoot(), 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
const COMPILE = flagsJson.compile['wasm32-wasip1-threads'].map(sub);

const LIB = '#pragma once\n#include <string>\n#include <vector>\n#include <map>\nint version();\nstd::string describe(const std::vector<int>& v);\n';
const MAIN = '#include "lib.h"\n#include <iostream>\nint main() {\n  std::cout << version() << describe({1, 2}) << std::endl;\n}\n';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session() {
	const work = join(tmpdir(), `perf-clangd-edit-${process.pid}`);
	rmSync(work, { recursive: true, force: true });
	const root = join(work, 'ws');
	for (const d of ['cfg', 'cache', 'ws', 'tmp']) { mkdirSync(join(work, d), { recursive: true }); }
	writeFileSync(join(root, 'lib.h'), LIB); writeFileSync(join(root, 'main.cpp'), MAIN);
	writeFileSync(join(root, 'compile_commands.json'), JSON.stringify([{ directory: '/workspace', file: '/workspace/main.cpp', arguments: ['clang++', ...COMPILE, ...DEFAULT_COMPILE_FLAGS, '/workspace/main.cpp'] }]));
	const child = spawn(process.execPath, ['--no-warnings', import.meta.filename, '--guest', work, root], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, PERF_STDERR_FILE: join(work, 'stderr.log') } });
	const send = msg => { const body = JSON.stringify({ jsonrpc: '2.0', ...msg }); child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
	const mark = {};
	const m = n => { mark[n] = Date.now(); };
	send({ id: 1, method: 'initialize', params: { processId: null, rootUri: 'file:///workspace', capabilities: {} } });
	await sleep(1500);
	send({ method: 'initialized', params: {} });
	const open = (f, text) => send({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///workspace/${f}`, languageId: 'cpp', version: 1, text } } });
	m('open'); open('lib.h', LIB); open('main.cpp', MAIN);
	await sleep(Number(process.env.WAIT_FIRST ?? 20000));
	let ver = 2;
	const change = (f, text) => send({ method: 'textDocument/didChange', params: { textDocument: { uri: `file:///workspace/${f}`, version: ver++ }, contentChanges: [{ text }] } });
	if (mode !== 'main') { m('headerEdit'); const edited = LIB + 'int added1();\n'; if (process.env.SAVE_TO_DISK) { writeFileSync(join(root, 'lib.h'), edited); } change('lib.h', edited); if (process.env.SAVE_TO_DISK) { send({ method: 'textDocument/didSave', params: { textDocument: { uri: 'file:///workspace/lib.h' } } }); } change('main.cpp', MAIN); }
	await sleep(Number(process.env.WAIT_EDIT ?? 15000));
	if (mode !== 'header') { m('mainEdit'); change('main.cpp', MAIN + '// edit\n'); await sleep(8000); }
	send({ id: 2, method: 'shutdown' }); send({ method: 'exit' });
	const exited = await Promise.race([new Promise(r => child.once("exit", () => r(true))), sleep(3000)]);
	child.kill();
	await sleep(500);
	const log = existsSync(join(work, 'stderr.log')) ? readFileSync(join(work, 'stderr.log'), 'utf8') : '';
	if (process.env.PERF_CLANGD_RAW) { console.log(log); }
	rmSync(work, { recursive: true, force: true });
	return log;
}

for (let i = 0; i < repeat; i++) {
	const log = await session();
	const lines = log.split('\n').filter(l => /preamble|Built|Reusing|Rebuilding|Updating|diagnostics/i.test(l) && !l.startsWith('V['));
	console.log(`--- run ${i + 1}`); console.log(lines.slice(0, 40).join('\n'));
}
