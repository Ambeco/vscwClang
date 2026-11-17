import * as assert from 'assert';
import type { BuildAction } from '../../buildgraph/classify';
import { BuildGraph, BuildGraphError } from '../../buildgraph/graph';

const compile = (source: string, output: string): BuildAction => ({ kind: 'compile', source, output, flags: [], command: `cc -c ${source}` });
const archive = (output: string, members: string[]): BuildAction => ({ kind: 'archive', output, members, command: `ar rcs ${output}` });
const link = (output: string, inputs: string[]): BuildAction => ({ kind: 'link', output, inputs, flags: [], command: `cc -o ${output}` });
const mkdir = (...paths: string[]): BuildAction => ({ kind: 'mkdir', paths, command: `mkdir ${paths.join(' ')}` });
const w = '/workspace';

suite('BuildGraph', () => {
	test('derives inputs and outputs from each action kind', () => {
		const g = new BuildGraph();
		assert.deepStrictEqual([g.addNode(compile(`${w}/a.c`, `${w}/a.o`))].map(n => [n.inputs, n.outputs]), [[[`${w}/a.c`], [`${w}/a.o`]]]);
		const n = g.addNode({ kind: 'write', path: `${w}/gen.h`, text: '', append: false, command: 'echo' });
		assert.deepStrictEqual([n.inputs, n.outputs], [[], [`${w}/gen.h`]]);
		const r = g.addNode({ kind: 'remove', paths: [`${w}/a.o`], glob: false, recursive: false, command: 'rm' });
		assert.deepStrictEqual([r.inputs, r.outputs], [[], []]);
	});

	test('nodesFor returns the goal and its dependencies in dependency order, leaving out the rest', () => {
		const g = new BuildGraph();
		g.addNode(compile(`${w}/unused.c`, `${w}/unused.o`));
		g.addNode(link(`${w}/test`, [`${w}/t.o`, `${w}/libx.a`]));
		g.addNode(archive(`${w}/libx.a`, [`${w}/lib.o`]));
		g.addNode(compile(`${w}/t.c`, `${w}/t.o`));
		g.addNode(compile(`${w}/lib.c`, `${w}/lib.o`));
		const order = g.nodesFor([`${w}/test`]).map(n => n.action.command);
		assert.deepStrictEqual(order.slice(-1), ['cc -o /workspace/test']);
		assert.strictEqual(order.length, 4);
		assert.ok(order.indexOf('ar rcs /workspace/libx.a') > order.indexOf('cc -c /workspace/lib.c'));
		assert.ok(!order.includes('cc -c /workspace/unused.c'));
	});

	test('a mkdir comes before everything written below it', () => {
		const g = new BuildGraph();
		g.addNode(compile(`${w}/a.c`, `${w}/build/a.o`));
		g.addNode(mkdir(`${w}/build`));
		const order = g.nodesFor([`${w}/build/a.o`]);
		assert.deepStrictEqual(order.map(n => n.action.kind), ['mkdir', 'compile']);
	});

	test('two compile/link/archive steps producing one file are rejected, repeated file actions are not', () => {
		const g = new BuildGraph();
		g.addNode(compile(`${w}/a.c`, `${w}/a.o`));
		assert.throws(() => g.addNode(compile(`${w}/b.c`, `${w}/a.o`)), (e: unknown) => e instanceof BuildGraphError && /produced twice/.test(e.message) && /Did you mean/.test(e.message));
		g.addNode(mkdir(`${w}/out`));
		g.addNode(mkdir(`${w}/out`));
		g.addNode({ kind: 'write', path: `${w}/log`, text: 'a', append: true, command: 'echo a >> log' });
		g.addNode({ kind: 'write', path: `${w}/log`, text: 'b', append: true, command: 'echo b >> log' });
	});

	test('a cycle is reported with the commands in it', () => {
		const g = new BuildGraph();
		g.addNode(compile(`${w}/b.o`, `${w}/a.o`));
		g.addNode(compile(`${w}/a.o`, `${w}/b.o`));
		assert.throws(() => g.validate(), (e: unknown) => e instanceof BuildGraphError && /cycle/.test(e.message) && /cc -c/.test(e.message));
	});

	test('an unknown goal suggests produced paths with the same file name', () => {
		const g = new BuildGraph();
		g.addNode(link(`${w}/build/app`, [`${w}/a.o`]));
		assert.throws(() => g.nodesFor([`${w}/app`]), (e: unknown) => e instanceof BuildGraphError && /no build step produces '\/workspace\/app'/.test(e.message) && /'\/workspace\/build\/app'/.test(e.message));
	});
});
