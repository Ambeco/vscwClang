// Compares compiling one C++ file with clang.wasm under our host (node:wasi, as perf-bench.mjs does) and under the Wasmer SDK
// (WASIX runtime, in-memory sandbox filesystem). A feasibility probe for moving the tool guests onto Wasmer; see
// documents/notes.md "Wasmer tool benchmark".
//   node scripts/perf-wasmer.mjs <wasmerSdkDir> <workDir> [--repeat 3] [--src hello|iostream]
// <wasmerSdkDir> holds node_modules/@wasmer/sdk (npm install @wasmer/sdk there, outside the repo); <workDir> is a scratch folder.
// Uses the single-threaded clang.wasm and the wasm32-wasip1 slice from VSCWCLANG_ARTIFACTS (or the newest release/<tag>).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWasi } from './clang-wasi.mjs';

const { artifactsRoot } = await import('../src/web/test/artifacts.ts');
const artifacts = artifactsRoot();
if (!artifacts) { throw new Error('no toolchain found; set VSCWCLANG_ARTIFACTS'); }

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) { return dflt; } const v = argv[i + 1]; argv.splice(i, 2); return v; };
const repeat = Number(opt('--repeat', '3'));
const srcKind = opt('--src', 'iostream');
const [sdkDir, workDir] = argv;
if (!sdkDir || !workDir) { throw new Error('usage: node scripts/perf-wasmer.mjs <wasmerSdkDir> <workDir> [--repeat 3] [--src hello|iostream]'); }

const flagsJson = JSON.parse(readFileSync(join(artifacts, 'compile-flags.json'), 'utf8'));
const sub = f => f.replace('${SYSROOT}', '/sysroot').replace('${RESOURCE}', '/resource');
const compileFlags = flagsJson.compile['wasm32-wasip1'].map(sub);
mkdirSync(workDir, { recursive: true });
const source = srcKind === 'hello' ? 'int main() { return 0; }\n' : '#include <iostream>\n#include <vector>\n#include <string>\nint main() { std::vector<std::string> v{"a"}; std::cout << v[0] << std::endl; }\n';
writeFileSync(join(workDir, 'hello.cpp'), source);
const args = ['clang++', '-fintegrated-cc1', '-c', '-fno-color-diagnostics', ...compileFlags, '/workspace/hello.cpp', '-o', '/workspace/hello.o'];
// The Wasmer sandbox filesystem only accepts paths under /workspace, so its sysroot and resource dir live there.
const wasmerArgs = args.map(a => a.replace(/(^|=|-isystem)\/(sysroot|resource)/, '$1/workspace/$2'));

const clangPath = join(artifacts, 'bin', 'clang.wasm');
const clangBytes = readFileSync(clangPath);
const resourceDir = join(artifacts, 'resource', 'lib', 'clang', flagsJson.clangResourceVersion);
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = xs => `median ${median(xs).toFixed(0)} ms (${xs.map(x => x.toFixed(0)).join(', ')})`;

// Our host
{
	const t0 = performance.now();
	const module = await WebAssembly.compile(clangBytes);
	console.log(`ours: WebAssembly.compile ${(performance.now() - t0).toFixed(0)} ms`);
	const times = [];
	for (let i = 0; i < repeat; i++) {
		const r = await runWasi(module, args, { '/sysroot': join(artifacts, 'sysroot'), '/resource': resourceDir, '/workspace': workDir }, clangBytes);
		if (r.code !== 0) { throw new Error(`ours: clang exited ${r.code}: ${r.stderr}`); }
		times.push(r.ms ?? NaN);
	}
	console.log(`ours: compile ${fmt(times)}`);
}

// Wasmer
function walk(dir, prefix, out) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) { walk(full, prefix, out); } else { out[`${prefix}/${relative(dirRoot, full).replace(/\\/g, '/')}`] = readFileSync(full); }
	}
	return out;
}
let dirRoot = '';
const { Wasmer } = await import(pathToFileURL(join(sdkDir, 'node_modules', '@wasmer', 'sdk', 'dist', 'node.js')).href);
let t = performance.now();
const wasmer = await Wasmer.create({ cache: 'memory' });
console.log(`wasmer: SDK init ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
const pkg = await wasmer.packages.load(clangBytes);
console.log(`wasmer: load clang.wasm ${(performance.now() - t).toFixed(0)} ms; commands: ${JSON.stringify(pkg.commands)} entrypoint: ${pkg.entrypoint}`);
t = performance.now();
const files = {};
dirRoot = join(artifacts, 'sysroot'); walk(dirRoot, '/workspace/sysroot', files);
dirRoot = resourceDir; walk(dirRoot, '/workspace/resource', files);
files['/workspace/hello.cpp'] = source;
console.log(`wasmer: read ${Object.keys(files).length} files ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
const sandbox = await wasmer.createSandbox({ files, packages: [pkg] });
console.log(`wasmer: sandbox seeded ${(performance.now() - t).toFixed(0)} ms`);
const times = [];
for (let i = 0; i < repeat; i++) {
	t = performance.now();
	const out = await sandbox.command(pkg.command(pkg.entrypoint ?? pkg.commands[0]), wasmerArgs.slice(1)).run({ timeoutMs: 120000 });
	const ms = performance.now() - t;
	if (out.exitCode !== 0) { throw new Error(`wasmer: clang exited ${out.exitCode}: ${out.stderr.text().slice(0, 2000)}`); }
	times.push(ms);
}
console.log(`wasmer: compile ${fmt(times)}`);
const obj = await sandbox.fs.readFile('/workspace/hello.o');
console.log(`wasmer: object ${obj.length} bytes`);
await wasmer.close();
process.exit(0);
