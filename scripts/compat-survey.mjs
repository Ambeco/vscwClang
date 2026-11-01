// Feasibility survey: compiles, links and runs real open-source projects with the repo's clang.wasm/lld.wasm under
// node:wasi, using the extension's own command lines (toolchain.ts build()), and records per-stage times.
//   node scripts/compat-survey.mjs <projectsDir> <name>[,<name>...] [--out results.json] [--timeout 300] [--j 1] [--only regex]
// Projects are defined in scripts/compat-projects.mjs. Each translation unit runs in its own worker_thread sharing one
// compiled WebAssembly.Module (like the extension's cached Module), so a hung unit is terminated and recorded.
import { WASI } from 'node:wasi';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, rmSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

if (!isMainThread) {
	const { module, args, preopens, stdinFile, stdoutFd, stderrFd } = workerData;
	const wasi = new WASI({ version: 'preview1', args, returnOnExit: true, preopens, stdin: stdinFile, stdout: stdoutFd, stderr: stderrFd, env: workerData.env ?? {} });
	const started = performance.now();
	let code, trap;
	try {
		const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
		code = wasi.start(instance);
	} catch (e) { trap = String(e && e.message || e); code = 139; }
	parentPort.postMessage({ code, trap, ms: performance.now() - started });
	process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const { artifactsRoot, artifactResource } = await import('../src/web/test/artifacts.ts');
const artifacts = artifactsRoot() ?? join(root, 'llvm-artifacts');
const flags = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
const COMPILE = flags.compile['wasm32-wasip1'].map(sub);
const LINK = flags.link['wasm32-wasip1'].map(sub);
// Mirror of DEFAULT_*_FLAGS in src/web/toolchain/toolchain.ts (that file imports vscode, so it cannot be loaded here).
const DEFAULT_COMPILE = ['-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_GETPID', '-D_WASI_EMULATED_PROCESS_CLOCKS'];
const DEFAULT_C = ['-mllvm', '-wasm-enable-sjlj'];
const DEFAULT_LINK = ['-lwasi-emulated-signal', '-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks', '-lsetjmp', '-z', 'stack-size=8388608'];
const { checkUserFlags } = await import('../src/web/toolchain/flagPolicy.ts');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) { return dflt; } const v = argv[i + 1]; argv.splice(i, 2); return v; };
const outFile = opt('--out', undefined);
const timeoutMs = Number(opt('--timeout', '300')) * 1000;
const jobs = Number(opt('--j', '1'));
const only = opt('--only', undefined);
const [projectsDir, names] = argv;
const modules = {};
const loadModule = async name => modules[name] ??= await WebAssembly.compile(readFileSync(join(artifacts, 'bin', name)));

/** Runs one tool invocation in a worker; returns { code, trap, ms, stdout, stderr, timedOut }. */
async function runTool(wasm, args, { preopens, stdin, env, timeout = timeoutMs }) {
	const module = await loadModule(wasm);
	const dir = join(tmpdir(), `compat-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir);
	const outPath = join(dir, 'out'), errPath = join(dir, 'err');
	const stdoutFd = openSync(outPath, 'w'), stderrFd = openSync(errPath, 'w');
	const stdinFile = stdin ? stdin : join(dir, 'in');
	if (!stdin) { writeFileSync(stdinFile, ''); }
	const stdinFd = openSync(stdinFile, 'r');
	const worker = new Worker(import.meta.filename, { workerData: { module, args, preopens, stdinFile: stdinFd, stdoutFd, stderrFd, env } });
	const started = performance.now();
	const result = await new Promise(res => {
		let timedOut = false;
		const timer = timeout > 0 ? setTimeout(() => { timedOut = true; worker.terminate(); }, timeout) : undefined;
		worker.once('message', m => { clearTimeout(timer); res({ ...m, timedOut }); });
		worker.once('error', e => { clearTimeout(timer); res({ code: 139, trap: String(e.message), ms: performance.now() - started, timedOut }); });
		worker.once('exit', () => { clearTimeout(timer); res({ code: timedOut ? 124 : 139, trap: timedOut ? 'timed out' : 'worker exited without result (out of memory?)', ms: performance.now() - started, timedOut }); });
	});
	closeSync(stdoutFd); closeSync(stderrFd); closeSync(stdinFd);
	const stdout = readFileSync(outPath), stderr = readFileSync(errPath, 'utf8');
	rmSync(dir, { recursive: true, force: true });
	return { ...result, stdout, stderr };
}

const tail = (s, n = 1500) => s.length > n ? '...' + s.slice(-n) : s;
const undef = s => [...new Set([...s.matchAll(/undefined symbol: (.+)/g)].map(m => m[1].trim()))];
const firstError = s => (s.split('\n').find(l => /error:|undefined symbol|cannot|not found/.test(l)) ?? s.split('\n')[0] ?? '').slice(0, 300);

async function survey(project, projectsDir) {
	const rootDir = join(projectsDir, project.dir);
	const objDir = join(tmpdir(), `compat-obj-${project.name}-${process.pid}`);
	rmSync(objDir, { recursive: true, force: true }); mkdirSync(objDir, { recursive: true });
	const stubDir = join(objDir, 'stubs'); mkdirSync(stubDir);
	for (const [name, text] of Object.entries(project.stubs ?? {})) { mkdirSync(dirname(join(stubDir, name)), { recursive: true }); writeFileSync(join(stubDir, name), text); }
	for (const [name, from] of Object.entries(project.stubFiles ?? {})) { mkdirSync(dirname(join(stubDir, name)), { recursive: true }); copyFileSync(from, join(stubDir, name)); }
	const preopens = { '/sysroot': join(artifacts, 'sysroot'), '/resource': artifactResource(), '/workspace': rootDir, '/stubs': stubDir };
	const report = { name: project.name, flags: project.flags, units: [], link: [], runs: [], policy: [] };
	const policy = checkUserFlags([...project.flags, ...(project.linkFlags ?? [])]);
	report.policy = policy;
	let units = [...project.units(rootDir), ...Object.keys(project.stubs ?? {}).filter(f => f.endsWith('.c') || f.endsWith('.cpp')).map(f => ({ file: f, abs: `/stubs/${f}` }))];
	if (only) { units = units.filter(u => new RegExp(only).test(u.file)); }
	console.log(`== ${project.name}: ${units.length} translation units`);
	const objects = [];
	let next = 0;
	const worker = async () => {
		while (next < units.length) {
			const i = next++;
			const u = units[i];
			const driver = u.file.endsWith('.c') ? 'clang' : 'clang++';
			const objPath = join(objDir, `${i}.o`);
			const r = await runTool('clang.wasm', [driver, ...COMPILE, '-fno-crash-diagnostics', '-fno-color-diagnostics', '-fno-caret-diagnostics', ...DEFAULT_COMPILE, ...(driver === 'clang' ? DEFAULT_C : []), ...project.flags, ...(u.flags ?? []), '-c', u.abs ?? `/workspace/${u.file}`, '-o', '-'], { preopens });
			if (r.code === 0) { writeFileSync(objPath, r.stdout); objects[i] = `/obj/${i}.o`; }
			const rec = { file: u.file, ok: r.code === 0, ms: Math.round(r.ms), exit: r.code, timedOut: r.timedOut, error: r.code === 0 ? '' : firstError(r.stderr + (r.trap ?? '')), warnings: (r.stderr.match(/warning:/g) ?? []).length, stderr: r.code === 0 ? '' : tail(r.stderr) };
			report.units.push(rec);
			console.log(`  ${rec.ok ? 'ok  ' : 'FAIL'} ${String(rec.ms).padStart(6)} ms  ${u.file}${rec.ok ? '' : '  -> ' + rec.error}`);
		}
	};
	await Promise.all(Array.from({ length: jobs }, worker));
	report.units.sort((a, b) => a.file.localeCompare(b.file));
	const okObjects = objects.filter(Boolean);
	const failed = report.units.filter(u => !u.ok).length;
	for (const link of project.links ?? [{ name: 'main', output: 'a.wasm' }]) {
		const wanted = link.select ? units.filter(u => link.select(u.file)) : units;
		const missing = wanted.filter(u => !report.units.find(r => r.file === u.file)?.ok);
		if (missing.length > 0) { console.log(`  link ${link.name}: skipped (${missing.length} needed units failed or not built: ${missing.map(u => u.file).slice(0, 3).join(', ')})`); report.link.push({ name: link.name, skipped: `${missing.length} needed units failed or not built` }); continue; }
		const selected = link.select ? objects.map((o, i) => o && link.select(units[i].file) ? o : undefined).filter(Boolean) : okObjects;
		const outDir = join(objDir, 'out'); mkdirSync(outDir, { recursive: true });
		const lpre = { ...preopens, '/obj': objDir, '/out': outDir };
		const r = await runTool('lld.wasm', ['wasm-ld', LINK[0], ...selected, ...(link.extraObjects ?? []), ...DEFAULT_LINK, ...(project.linkFlags ?? []), ...LINK.slice(1), '-o', `/out/${link.output}`], { preopens: lpre });
		const size = r.code === 0 && existsSync(join(outDir, link.output)) ? statSync(join(outDir, link.output)).size : 0;
		report.link.push({ name: link.name, ok: r.code === 0, ms: Math.round(r.ms), size, objects: selected.length, error: r.code === 0 ? '' : firstError(r.stderr), undefinedSymbols: undef(r.stderr), stderr: r.code === 0 ? '' : tail(r.stderr, 3000) });
		console.log(`  link ${link.name}: ${r.code === 0 ? 'ok' : 'FAIL'} ${Math.round(r.ms)} ms, ${size} bytes${r.code === 0 ? '' : '  -> ' + (undef(r.stderr).length ? 'undefined: ' + undef(r.stderr).join(', ') : firstError(r.stderr))}`);
	}
	return { report, objDir, preopens };
}

// Run phase: separate because it needs the linked wasm; implemented against the same objDir/out layout.
async function runPhase(project, ctx) {
	const outDir = join(ctx.objDir, 'out');
	for (const run of project.runs ?? []) {
		const wasmPath = join(outDir, run.output);
		if (!existsSync(wasmPath)) { ctx.report.runs.push({ name: run.name, skipped: `${run.output} was not linked` }); continue; }
		const scratch = join(ctx.objDir, 'tmp'); mkdirSync(scratch, { recursive: true });
		const module = await WebAssembly.compile(readFileSync(wasmPath));
		const key = `prog:${run.output}`; modules[key] = module;
		const r = await runTool(key, [run.output, ...run.args], { preopens: { '/workspace': ctx.preopens['/workspace'], '/tmp': scratch, ...(run.preopens ?? {}) }, stdin: run.stdin, env: { HOME: '/tmp', TMPDIR: '/tmp', ...(run.env ?? {}) }, timeout: run.timeout ?? 120000 });
		const out = r.stdout.toString('utf8');
		const ok = run.expect ? run.expect(r.code, out, r.stderr) : r.code === 0;
		ctx.report.runs.push({ name: run.name, ok, exit: r.code, ms: Math.round(r.ms), trap: r.trap, timedOut: r.timedOut, stdout: tail(out, 800), stderr: tail(r.stderr, 800) });
		console.log(`  run ${run.name}: ${ok ? 'ok' : 'FAIL'} exit ${r.code} ${Math.round(r.ms)} ms${r.trap ? ' trap: ' + r.trap : ''}`);
		if (!ok) { console.log('    ' + tail(out + r.stderr, 400).replace(/\n/g, '\n    ')); }
	}
}

const { PROJECTS } = await import('./compat-projects.mjs');
const results = [];
for (const name of names.split(',')) {
	const project = PROJECTS[name];
	if (!project) { throw new Error(`unknown project '${name}'; did you mean one of ${Object.keys(PROJECTS).join(', ')}?`); }
	project.name = name;
	const ctx = await survey(project, projectsDir);
	await runPhase(project, ctx);
	results.push(ctx.report);
	rmSync(ctx.objDir, { recursive: true, force: true });
	if (outFile) { writeFileSync(outFile, JSON.stringify(results, null, 1)); }
}
const total = r => r.units.reduce((s, u) => s + u.ms, 0);
for (const r of results) {
	const ok = r.units.filter(u => u.ok).length;
	console.log(`${r.name}: ${ok}/${r.units.length} units ok, compile total ${(total(r) / 1000).toFixed(1)} s, max ${Math.max(0, ...r.units.map(u => u.ms))} ms`);
}
