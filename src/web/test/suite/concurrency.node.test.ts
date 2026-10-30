import * as assert from 'assert';
import { forEachLimited } from '../../toolchain/concurrency';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

suite('forEachLimited', () => {
	test('never runs more than the limit at once, and visits every item with its index', async () => {
		let running = 0, peak = 0;
		const seen: number[] = [];
		await forEachLimited(['a', 'b', 'c', 'd', 'e'], 2, async (_item, i) => {
			peak = Math.max(peak, ++running);
			await tick();
			seen[i] = i;
			running--;
		});
		assert.strictEqual(peak, 2);
		assert.deepStrictEqual(seen, [0, 1, 2, 3, 4]);
	});

	test('a limit above the item count, or below 1, still completes', async () => {
		const seen: string[] = [];
		await forEachLimited(['x', 'y'], 10, async item => { seen.push(item); });
		await forEachLimited(['z'], 0, async item => { seen.push(item); });
		assert.deepStrictEqual(seen.sort(), ['x', 'y', 'z']);
	});

	test('a failure stops new work, lets running work finish, and is rethrown', async () => {
		const started: number[] = [];
		await assert.rejects(forEachLimited([0, 1, 2, 3, 4, 5], 2, async i => {
			started.push(i);
			await tick();
			if (i === 1) { throw new Error('boom'); }
		}), /boom/);
		assert.ok(started.length < 6, `started ${started.join(',')}`);
		assert.ok(started.includes(0) && started.includes(1));
	});
});
