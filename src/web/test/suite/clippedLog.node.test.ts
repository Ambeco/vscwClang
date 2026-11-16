import * as assert from 'assert';
import { ClippedLog } from '../../clangd/clippedLog';

suite('ClippedLog', () => {
	test('text appended before a flush is written in one call', () => {
		const writes: string[] = [];
		const log = new ClippedLog(t => writes.push(t));
		['a', 'b\n', 'c'].forEach(t => log.append(t));
		assert.deepStrictEqual(writes, []);
		log.flush();
		assert.deepStrictEqual(writes, ['ab\nc']);
	});

	test('a timer flushes by itself', async () => {
		const writes: string[] = [];
		const log = new ClippedLog(t => writes.push(t), 100, 5);
		log.append('hello\n');
		await new Promise(r => setTimeout(r, 40));
		assert.deepStrictEqual(writes, ['hello\n']);
	});

	test('a line over the limit is cut and says how much was left out; the next line is whole', () => {
		const writes: string[] = [];
		const log = new ClippedLog(t => writes.push(t), 10);
		log.append(`${'x'.repeat(25)}\nshort\n`);
		log.flush();
		assert.deepStrictEqual(writes, ['xxxxxxxxxx ... [15 more characters not shown]\nshort\n']);
	});

	test('a long line split across flushes is clipped once, with the total left out', () => {
		const writes: string[] = [];
		const log = new ClippedLog(t => writes.push(t), 10);
		log.append('abcdef'); log.flush();
		log.append('ghijklmnop'); log.flush();
		log.append('qrst\nnext\n'); log.flush();
		assert.deepStrictEqual(writes, ['abcdef', 'ghij', ' ... [10 more characters not shown]\nnext\n']);
	});

	test('a megabyte line becomes a short one', () => {
		const writes: string[] = [];
		const log = new ClippedLog(t => writes.push(t));
		log.append(`{"text":"${'y'.repeat(1_800_000)}"}\n`);
		log.flush();
		assert.ok(writes[0].length < 4100, String(writes[0].length));
		assert.match(writes[0], /\.\.\. \[\d+ more characters not shown\]\n$/);
	});

	test('flush with nothing pending writes nothing', () => {
		const writes: string[] = [];
		new ClippedLog(t => writes.push(t)).flush();
		assert.deepStrictEqual(writes, []);
	});
});
