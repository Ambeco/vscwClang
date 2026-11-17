import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraphFromMake, MakeTraceError, parseMakeTrace } from '../../buildgraph/makeTrace';
import { lowerToBuildRequest } from '../../buildgraph/lower';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'src', 'web', 'test', 'fixtures', 'make', name), 'utf8');
const HOST_ROOT = 'C:/Users/mooin/scratch-make/f3';
const rejects = (fn: () => unknown, pattern: RegExp) =>
	assert.throws(fn, (e: unknown) => e instanceof MakeTraceError && pattern.test(e.message) && /Did you mean/.test(e.message), String(pattern));

suite('parseMakeTrace', () => {
	test('attributes each recipe line to its target and reason', () => {
		const t = parseMakeTrace(fixture('libtest.B.trace.txt'));
		assert.deepStrictEqual(t.recipes.map(r => [r.target, r.reason, r.makefile, r.line, r.commands.length]), [
			['lib.o', 'target does not exist', 'Makefile', 11, 1],
			['libx.a', 'target does not exist', 'Makefile', 5, 3],
			['t.o', 'target does not exist', 'Makefile', 11, 1],
			['test', 'target does not exist', 'Makefile', 9, 1],
		]);
		assert.deepStrictEqual(t.recipes[1].commands, ['echo archiving', 'ar rcs libx.a lib.o', 'ranlib libx.a']);
		assert.strictEqual(t.complete, true);
		assert.deepStrictEqual([t.preamble, t.problems, t.messages], [[], [], []]);
		assert.ok(t.recipes.every(r => r.cwd === '/workspace'));
	});

	test('without -B the reasons name changed prerequisites and the trace is incomplete', () => {
		const t = parseMakeTrace(fixture('libtest.partial.trace.txt'));
		assert.deepStrictEqual(t.recipes.map(r => [r.target, r.reason]), [['lib.o', 'lib.c'], ['libx.a', 'lib.o'], ['test', 'libx.a']]);
		assert.strictEqual(t.complete, false);
	});

	test('an up-to-date tree has no recipes, only a message', () => {
		const t = parseMakeTrace(fixture('libtest.uptodate.trace.txt'));
		assert.deepStrictEqual([t.recipes.length, t.messages], [0, ["make: Nothing to be done for 'all'."]]);
	});

	test('a phony target is complete, and its commands keep their wildcards', () => {
		const t = parseMakeTrace(fixture('libtest.clean.trace.txt'));
		assert.deepStrictEqual(t.recipes.map(r => [r.target, r.reason, r.commands]), [['clean', 'target is .PHONY', ['rm -f *.o *.a test']]]);
		assert.strictEqual(t.complete, true);
	});

	test('a sub-make runs its recipes in the directory it entered, rebased onto the workspace', () => {
		const t = parseMakeTrace(fixture('libtest.sub.trace.txt'), HOST_ROOT);
		assert.deepStrictEqual(t.recipes.map(r => [r.target, r.cwd]), [['sub', '/workspace'], ['all', '/workspace/sub']]);
		assert.ok(t.recipes[0].commands[0].includes('make.exe -C sub all'));
	});

	test('output from make.wasm: a command before any target, a warning and an error are kept apart', () => {
		const t = parseMakeTrace(fixture('wasmcase.sub.trace.txt'));
		assert.deepStrictEqual(t.preamble, ["echo 'GEN=1' > gen.mk"]);
		assert.deepStrictEqual(t.problems, ['Makefile:4: pipe: Function not implemented', 'make: *** [Makefile:17: sub] Error 127']);
		assert.deepStrictEqual(t.recipes.map(r => [r.target, r.cwd]), [['sub', '/workspace']]);
	});
});

suite('buildGraphFromMake', () => {
	test('the library and test program of a make dry run lower onto a build request', () => {
		const { graph, notes, trace } = buildGraphFromMake(fixture('libtest.B.trace.txt'));
		assert.strictEqual(trace.complete, true);
		assert.deepStrictEqual(graph.nodes.map(n => [n.action.kind, n.target]), [
			['compile', 'lib.o'], ['noop', 'libx.a'], ['archive', 'libx.a'], ['noop', 'libx.a'], ['compile', 't.o'], ['link', 'test'],
		]);
		assert.deepStrictEqual(notes, []);
		const lowered = lowerToBuildRequest(graph, '/workspace/test');
		assert.deepStrictEqual(lowered.sources, ['t.c', 'lib.c']);
		assert.deepStrictEqual(lowered.sourceFlags['/workspace/lib.c'], ['-O2', '-Wall', '-DNAME=1']);
		assert.deepStrictEqual(lowered.flags, ['-L/workspace']);
	});

	test('a sub-make line is skipped and the sub-directory recipes join the graph', () => {
		const { graph, notes } = buildGraphFromMake(fixture('libtest.sub.trace.txt'), HOST_ROOT);
		assert.ok(notes.some(n => /recursive make line of target 'sub'/.test(n)));
		const compile = graph.nodes.find(n => n.action.kind === 'compile');
		assert.deepStrictEqual([compile?.inputs, compile?.outputs], [['/workspace/main.c'], ['/workspace/sub/main.o']]);
	});

	test('clean builds a remove action, with its glob flag', () => {
		const { graph } = buildGraphFromMake(fixture('libtest.clean.trace.txt'));
		assert.deepStrictEqual(graph.nodes.map(n => n.action.kind === 'remove' && n.action.glob), [true]);
	});

	test('an incomplete trace is accepted with a warning note, and lowering then names the missing object', () => {
		const { graph, notes } = buildGraphFromMake(fixture('libtest.partial.trace.txt'));
		assert.ok(notes.some(n => /not made with -B/.test(n)));
		assert.throws(() => lowerToBuildRequest(graph, '/workspace/test'), (e: unknown) => e instanceof Error && /'\/workspace\/t\.o' is a prebuilt/.test(e.message));
	});

	test('make.wasm output with a generated include, a failed $(shell) or a failed sub-make is refused', () => {
		rejects(() => buildGraphFromMake(fixture('wasmcase.all.trace.txt')), /Function not implemented/);
		rejects(() => buildGraphFromMake(fixture('wasmcase.sub.trace.txt')), /Function not implemented/);
		rejects(() => buildGraphFromMake(fixture('wasmcase.sub.trace.txt')), /Error 127/);
		const withoutWarnings = fixture('wasmcase.all.trace.txt').split('\n').filter(l => !/pipe:/.test(l)).join('\n');
		rejects(() => buildGraphFromMake(withoutWarnings), /remaking an included makefile|remakes an included makefile|remake an included makefile/);
	});

	test('an unmappable command names the target and makefile line', () => {
		const text = "Makefile:3: update target 'gen.h' due to: target does not exist\nsed -e s/a/b/ in\n";
		rejects(() => buildGraphFromMake(text), /In the recipe for target 'gen\.h' \(Makefile:3\).*cannot map the command 'sed'/);
	});

	test('a shell construct make left in a recipe is refused with the target named', () => {
		const text = "Makefile:3: update target 'x' due to: target does not exist\nfor f in a b; do cc -c a.c; done\n";
		rejects(() => buildGraphFromMake(text), /In the recipe for target 'x'.*control syntax `for`/);
	});
});
