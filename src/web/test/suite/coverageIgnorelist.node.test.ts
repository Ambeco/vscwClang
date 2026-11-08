import * as assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { artifactBin, artifactPath, artifactResource } from '../artifacts';
import { COVERAGE_IGNORELIST } from '../../debug/coverageIgnorelist';
import { scanProgram } from '../../debug/wasmScan';

const SOURCE = [
	'#include <vector>', '#include <algorithm>', '#include <cstdio>',
	'static int twice(int x) {', '  return x * 2;', '}',
	'int main() {', '  std::vector<int> v;', '  for (int i = 0; i < 5; i++)', '    v.push_back(twice(i));',
	'  std::sort(v.begin(), v.end());', '  std::puts(v.empty() ? "empty" : "full");', '  return 0;', '}', '',
].join('\n');

suite('coverage ignorelist (real clang, needs llvm-artifacts)', function () {
	this.timeout(120000);
	const ready = existsSync(artifactBin('clang.wasm')) && existsSync(artifactBin('lld.wasm'));
	let work: string;
	suiteSetup(function () { if (!ready) { this.skip(); } work = mkdtempSync(join(tmpdir(), 'vscw-ignore-')); });
	suiteTeardown(() => { if (work) { rmSync(work, { recursive: true, force: true }); } });

	async function run(tool: string, args: string[]): Promise<void> {
		// Not a static import: the module re-launches itself as a Worker, so esbuild must not bundle it.
		const { runWasi } = await import(pathToFileURL(resolve('scripts/clang-wasi.mjs')).href) as { runWasi: (m: WebAssembly.Module, a: string[], p: Record<string, string>, b: Uint8Array) => Promise<{ code: number; stderr: string }> };
		const bytes = readFileSync(artifactBin(tool));
		// -fintegrated-cc1: the threaded driver would spawn cc1 as a subprocess, which clang-wasi.mjs does not provide.
		const toolArgs = tool === 'clang.wasm' ? [args[0], '-fintegrated-cc1', ...args.slice(1)] : args;
		const r = await runWasi(await WebAssembly.compile(bytes), toolArgs, { '/sysroot': artifactPath('sysroot'), '/resource': artifactResource(), '/work': work }, bytes);
		assert.strictEqual(r.code, 0, `${tool} ${args.join(' ')} exited with ${r.code}: ${r.stderr}`);
	}

	async function guardedFunctions(tag: string, extra: string[]): Promise<string[]> {
		const flags = JSON.parse(readFileSync(artifactPath('compile-flags.json'), 'utf8'));
		const sub = (f: string) => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
		const compile = (flags.compile['wasm32-wasip1'] as string[]).map(sub), link = (flags.link['wasm32-wasip1'] as string[]).map(sub);
		await run('clang.wasm', ['clang++', ...compile, '-std=c++17', '-O0', '-g', '-fsanitize-coverage=trace-pc-guard,no-prune', ...(flags.debugCoverage ?? []), ...extra, '-c', '/work/t.cpp', '-o', `/work/${tag}.o`]);
		await run('lld.wasm', ['wasm-ld', link[0], `/work/${tag}.o`, '--export=__stack_pointer', '--allow-undefined', ...link.slice(1), '-o', `/work/${tag}.wasm`]);
		const scan = scanProgram(new Uint8Array(readFileSync(join(work, `${tag}.wasm`))));
		return [...new Set([...scan.guardSites.values()].map(s => scan.module.names.get(s.funcIndex) ?? '?'))];
	}

	test('without the ignorelist the standard library is instrumented; with it only the program\'s own functions are', async () => {
		writeFileSync(join(work, 't.cpp'), SOURCE);
		writeFileSync(join(work, 'ignore.txt'), COVERAGE_IGNORELIST);
		const all = await guardedFunctions('all', []);
		assert.ok(all.some(n => n.startsWith('std::')), 'baseline instruments std:: functions');
		const own = await guardedFunctions('own', ['-fsanitize-coverage-ignorelist=/work/ignore.txt']);
		assert.deepStrictEqual(own.filter(n => n.startsWith('std::') || n.includes('std::__1')), [], 'no std:: function keeps a guard');
		assert.ok(own.includes('twice(int)') && own.includes('__original_main'), `user functions keep theirs: ${own.join(', ')}`);
	});
});
