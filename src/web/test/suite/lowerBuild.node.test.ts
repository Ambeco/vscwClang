import * as assert from 'assert';
import { classifyShellLine } from '../../buildgraph/classify';
import { BuildGraph, BuildGraphError } from '../../buildgraph/graph';
import { linkOutputs, LowerError, lowerToBuildRequest } from '../../buildgraph/lower';

function graphOf(lines: string[], cwd = '/workspace'): BuildGraph {
	const g = new BuildGraph();
	for (const line of lines) { classifyShellLine(line, { cwd }).actions.forEach(a => g.addNode(a)); }
	return g;
}
const rejects = (fn: () => unknown, pattern: RegExp) =>
	assert.throws(fn, (e: unknown) => e instanceof LowerError && pattern.test(e.message) && /Did you mean/.test(e.message));

suite('lowerToBuildRequest', () => {
	test('linkOutputs lists each linked program in build order', () => {
		const g = graphOf(['cc -c a.c -o a.o', 'cc -o first a.o', 'ar rcs libb.a a.o', 'cc -c b.c -o b.o', 'cc -o second b.o -L. -lb']);
		assert.deepStrictEqual(linkOutputs(g), ['/workspace/first', '/workspace/second']);
	});

	test('a library and a test program: the archive is folded in and -lx is dropped', () => {
		const g = graphOf([
			'cc -O2 -Wall -c lib.c -o lib.o',
			'ar rcs libx.a lib.o',
			'ranlib libx.a',
			'cc -O2 -Wall -c t.c -o t.o',
			'cc -o test t.o -L. -lx',
		]);
		const r = lowerToBuildRequest(g, '/workspace/test');
		assert.deepStrictEqual(r.sources, ['t.c', 'lib.c']);
		assert.deepStrictEqual(r.sourceFlags, { '/workspace/t.c': ['-O2', '-Wall'], '/workspace/lib.c': ['-O2', '-Wall'] });
		assert.deepStrictEqual(r.flags, ['-L/workspace']);
		assert.strictEqual(r.output, 'test');
		assert.strictEqual(r.mode, 'release');
		assert.ok(r.notes.some(n => /folded static library '\/workspace\/libx\.a'/.test(n)));
	});

	test('a library passed by file name is folded too, and -lm/-Wl,/-pthread stay link flags', () => {
		const g = graphOf(['cc -c a.c -o a.o', 'ar cr libz.a a.o', 'cc -c m.c -o m.o', 'cc -pthread -o app m.o libz.a -lm -Wl,--gc-sections']);
		const r = lowerToBuildRequest(g, '/workspace/app');
		assert.deepStrictEqual(r.sources, ['m.c', 'a.c']);
		assert.deepStrictEqual(r.flags, ['-pthread', '-lm', '-Wl,--gc-sections']);
	});

	test('sources named on the link line take its compile flags', () => {
		const g = graphOf(['cc -O2 -g -o app main.c util.c -lm']);
		const r = lowerToBuildRequest(g, '/workspace/app');
		assert.deepStrictEqual(r.sources, ['main.c', 'util.c']);
		assert.deepStrictEqual(r.sourceFlags['/workspace/main.c'], ['-O2', '-g']);
		assert.deepStrictEqual(r.flags, ['-lm']);
		assert.strictEqual(r.mode, 'debug');
	});

	test('compile flags on a link line with only objects are dropped with a note', () => {
		const g = graphOf(['cc -c a.c -o a.o', 'cc -O3 -o app a.o']);
		const r = lowerToBuildRequest(g, '/workspace/app');
		assert.deepStrictEqual(r.sourceFlags['/workspace/a.c'], []);
		assert.ok(r.notes.some(n => /dropped '-O3'/.test(n)));
	});

	test('a source reached twice with the same flags is kept once', () => {
		const g = graphOf(['cc -c a.c -o a.o', 'ar rcs liba.a a.o', 'ar rcs libb.a a.o', 'cc -o app libb.a liba.a']);
		assert.deepStrictEqual(lowerToBuildRequest(g, '/workspace/app').sources, ['a.c']);
	});

	test('the same source with different flags is rejected', () => {
		const g = graphOf(['cc -O0 -c a.c -o a0.o', 'cc -O2 -c a.c -o a2.o', 'cc -o app a0.o a2.o']);
		rejects(() => lowerToBuildRequest(g, '/workspace/app'), /compiled twice with different flags/);
	});

	test('a generated source, a prebuilt object and a non-program goal are rejected with the step named', () => {
		rejects(() => lowerToBuildRequest(graphOf(["echo 'int x;' > gen.c", 'cc -c gen.c -o gen.o', 'cc -o app gen.o']), '/workspace/app'), /made by `echo int x;`, a write step/);
		rejects(() => lowerToBuildRequest(graphOf(['cc -o app main.c vendor.a']), '/workspace/app'), /'\/workspace\/vendor\.a' is a prebuilt/);
		rejects(() => lowerToBuildRequest(graphOf(['cc -c a.c -o a.o', 'ar rcs liba.a a.o']), '/workspace/liba.a'), /not a link/);
		rejects(() => lowerToBuildRequest(graphOf(['cc -c a.c -o a.o']), '/workspace/a.o'), /a compile step, not a link/);
	});

	test('an unknown goal is a graph error with suggestions', () => {
		assert.throws(() => lowerToBuildRequest(graphOf(['cc -o build/app main.c']), '/workspace/app'), BuildGraphError);
	});

	test('mkdir steps are ignored, output directories and nested sources map to relative paths', () => {
		const g = graphOf(['mkdir -p build', 'cc -Iinclude -c src/main.c -o build/main.o', 'cc -o build/app build/main.o']);
		const r = lowerToBuildRequest(g, '/workspace/build/app');
		assert.deepStrictEqual(r.sources, ['src/main.c']);
		assert.deepStrictEqual(r.sourceFlags['/workspace/src/main.c'], ['-I/workspace/include']);
		assert.strictEqual(r.output, 'build/app');
	});

	test('a graph with a cycle is rejected before lowering', () => {
		const g = graphOf(['cc -c a.c -o b.c', 'cc -c b.c -o a.c', 'cc -o app a.c']);
		assert.throws(() => lowerToBuildRequest(g, '/workspace/app'), BuildGraphError);
	});
});
