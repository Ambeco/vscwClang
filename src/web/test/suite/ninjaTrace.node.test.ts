import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkOutputs, lowerToBuildRequest } from '../../buildgraph/lower';
import { expandCommand, NinjaParseError, parseNinja, type NinjaManifest } from '../../buildgraph/ninjaParse';
import { buildGraphFromNinja, NinjaTraceError } from '../../buildgraph/ninjaTrace';

const dir = (name: string) => join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'ninja', name);
const load = (name: string): NinjaManifest => parseNinja(readFileSync(join(dir(name), 'build.ninja'), 'utf8'), 'build.ninja', p => readFileSync(join(dir(name), p), 'utf8'));
const inMemory = (files: Record<string, string>) => parseNinja(files['build.ninja'], 'build.ninja', p => { if (!(p in files)) { throw new Error('no such file'); } return files[p]; });
const UNIX = { buildDir: '/home/dev/proj/build', hostRoot: '/home/dev/proj' };
const WINDOWS = { buildDir: 'C:/work/proj/build', hostRoot: 'C:/work/proj' };
const rejects = (fn: () => unknown, pattern: RegExp) =>
	assert.throws(fn, (e: unknown) => (e instanceof NinjaTraceError || e instanceof NinjaParseError) && pattern.test(e.message) && /Did you mean/.test(e.message), String(pattern));

suite('parseNinja', () => {
	test('follows include and reads rules, edges and defaults', () => {
		const m = load('unix');
		assert.ok(m.rules.has('CXX_EXECUTABLE_LINKER__format-test_'));
		assert.deepStrictEqual(m.defaults, ['all']);
		const link = m.edges.find(e => e.outputs[0] === 'format-test');
		assert.deepStrictEqual([link?.inputs, link?.implicitInputs, link?.orderOnlyInputs], [['CMakeFiles/format-test.dir/src/test.cpp.o'], ['libmylib.a'], ['libmylib.a']]);
		assert.strictEqual(link?.bindings.LINK_LIBRARIES, 'libmylib.a');
	});

	test('expands $in, $out, edge bindings and unset variables in the command', () => {
		const m = load('unix');
		const edge = m.edges.find(e => e.outputs[0] === 'CMakeFiles/mylib.dir/src/lib.cpp.o');
		assert.strictEqual(expandCommand(m, edge!), '/usr/bin/c++ -DMYLIB=1 -I/home/dev/proj/include -g -std=gnu++17 -MD -MT CMakeFiles/mylib.dir/src/lib.cpp.o -MF CMakeFiles/mylib.dir/src/lib.cpp.o.d -o CMakeFiles/mylib.dir/src/lib.cpp.o -c /home/dev/proj/src/lib.cpp');
	});

	test('handles $ escapes, line continuations and variable scope', () => {
		const m = inMemory({ 'build.ninja': 'cc = gcc\nrule r\n  command = $cc $flags -o $out $in\nbuild C$:/a$ b/out.o: r in$\n  put.c | extra.h || order\n  flags = -O2 -DX=$$1 ${cc}\n' });
		const e = m.edges[0];
		assert.deepStrictEqual([e.outputs, e.inputs, e.implicitInputs, e.orderOnlyInputs], [['C:/a b/out.o'], ['input.c'], ['extra.h'], ['order']]);
		assert.strictEqual(expandCommand(m, e), "gcc -O2 -DX=$1 gcc -o 'C:/a b/out.o' input.c");
	});

	test('substitutes the response file content for @rspfile', () => {
		const m = inMemory({ 'build.ninja': 'rule link\n  command = ld @$out.rsp\n  rspfile = $out.rsp\n  rspfile_content = $in\nbuild x: link a.o b.o\n' });
		assert.strictEqual(expandCommand(m, m.edges[0]), 'ld a.o b.o');
	});

	test('rejects an unknown rule, a missing include and a rule used before its definition, with suggestions', () => {
		rejects(() => inMemory({ 'build.ninja': 'rule cc\n  command = x\nbuild a: cxx b\n' }), /unknown rule 'cxx'.*Did you mean one of cc/);
		rejects(() => inMemory({ 'build.ninja': 'include nope.ninja\n' }), /cannot read included file 'nope.ninja'.*Did you mean/);
		rejects(() => inMemory({ 'build.ninja': 'wat is this\n' }), /unrecognised statement/);
	});
});

suite('buildGraphFromNinja (CMake, Unix paths)', () => {
	test('format-test links a library from another target through the archive', () => {
		const { graph, goalOutputs } = buildGraphFromNinja(load('unix'), { ...UNIX, goals: ['format-test'] });
		assert.deepStrictEqual(goalOutputs, ['/workspace/build/format-test']);
		assert.deepStrictEqual(graph.nodes.map(n => n.action.kind), ['compile', 'compile', 'remove', 'archive', 'noop', 'link']);
		const lowered = lowerToBuildRequest(graph, '/workspace/build/format-test');
		assert.deepStrictEqual(lowered.sources.sort(), ['src/lib.cpp', 'src/test.cpp']);
		assert.deepStrictEqual(lowered.sourceFlags['/workspace/src/lib.cpp'], ['-DMYLIB=1', '-I/workspace/include', '-g', '-std=gnu++17']);
		assert.strictEqual(lowered.mode, 'debug');
		assert.deepStrictEqual(lowered.flags, []);
	});

	test('the default goal is the manifest default (all), and skips the cache editor and RERUN_CMAKE edges', () => {
		const { graph } = buildGraphFromNinja(load('unix'), UNIX);
		assert.deepStrictEqual(linkOutputs(graph), ['/workspace/build/format-test']);
		assert.ok(graph.nodes.every(n => !/ccmake|regenerate/.test(n.action.command)));
	});

	test('a phony target name (mylib) builds just that library', () => {
		const { graph, goalOutputs } = buildGraphFromNinja(load('unix'), { ...UNIX, goals: ['mylib'] });
		assert.deepStrictEqual(goalOutputs, ['/workspace/build/libmylib.a']);
		assert.deepStrictEqual(linkOutputs(graph), []);
	});

	test('edges in reverse file order produce the same lowering', () => {
		const m = load('unix');
		m.edges.reverse();
		const { graph } = buildGraphFromNinja(m, { ...UNIX, goals: ['format-test'] });
		const lowered = lowerToBuildRequest(graph, '/workspace/build/format-test');
		assert.deepStrictEqual(lowered.sources.sort(), ['src/lib.cpp', 'src/test.cpp']);
		assert.strictEqual(graph.nodes.findIndex(n => n.action.kind === 'archive') < graph.nodes.findIndex(n => n.action.kind === 'link'), true);
	});

	test('dependency-file flags (-MD -MT -MF) do not reach the compile flags', () => {
		const { graph } = buildGraphFromNinja(load('unix'), { ...UNIX, goals: ['libmylib.a'] });
		const compile = graph.nodes.find(n => n.action.kind === 'compile')!.action;
		assert.ok(compile.kind === 'compile' && !compile.flags.some(f => /^-M/.test(f) || f.endsWith('.d')), JSON.stringify(compile));
	});

	test('an unknown goal lists close targets; a generator edge as goal is refused', () => {
		rejects(() => buildGraphFromNinja(load('unix'), { ...UNIX, goals: ['format-tests'] }), /no target 'format-tests'.*Did you mean 'format-test'/);
		rejects(() => buildGraphFromNinja(load('unix'), { ...UNIX, goals: ['build.ninja'] }), /CMake re-running itself/);
	});

	test('a build directory outside the workspace is refused', () => {
		rejects(() => buildGraphFromNinja(load('unix'), { buildDir: '/elsewhere/build', hostRoot: '/home/dev/proj' }), /outside the workspace folder/);
	});

	test('an unmappable command in a needed edge names the edge and file line', () => {
		const m = inMemory({ 'build.ninja': 'rule gen\n  command = python3 gen.py $out\nrule cc\n  command = c++ -c $in -o $out\nbuild gen.h: gen\nbuild a.o: cc a.cpp | gen.h\nbuild all: phony a.o\n' });
		rejects(() => buildGraphFromNinja(m, { buildDir: '/workspace', goals: ['all'] }), /build step for 'gen\.h' \(build\.ninja:5\).*python3/);
	});
});

suite('buildGraphFromNinja (CMake, Windows paths)', () => {
	test('reads the real output of CMake 4.4 on Windows: cmd.exe wrapper, C$: escapes, backslashes', () => {
		const { graph } = buildGraphFromNinja(load('windows'), { ...WINDOWS, goals: ['format-test'] });
		const lowered = lowerToBuildRequest(graph, '/workspace/build/format-test');
		assert.deepStrictEqual(lowered.sources.sort(), ['src/lib.cpp', 'src/test.cpp']);
		assert.deepStrictEqual(lowered.sourceFlags['/workspace/src/test.cpp'], ['-DMYLIB=1', '-I/workspace/include']);
	});
});

suite('cmake -E in build steps', () => {
	const run = (command: string) => buildGraphFromNinja(inMemory({ 'build.ninja': `rule r\n  command = ${command}\nbuild x: r\n` }), { buildDir: '/workspace', goals: ['x'] }).graph.nodes.map(n => n.action.kind);
	test('maps rm, make_directory, touch, copy and echo', () => {
		assert.deepStrictEqual(run('cmake -E rm -f a.o && cmake -E make_directory d && cmake -E touch d/t && cmake -E copy_if_different a b && cmake -E cmake_echo_color --blue hi'), ['remove', 'mkdir', 'touch', 'copy', 'noop']);
	});
	test('refuses other subcommands and running cmake itself, with suggestions', () => {
		rejects(() => run('cmake -E tar cf a.tar a'), /'cmake -E tar' is not supported.*Supported are rm/);
		rejects(() => run('cmake -P gen.cmake'), /running CMake itself.*Did you mean/);
	});
});
