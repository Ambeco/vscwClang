/**
 * Runs `work` over `items` with at most `limit` in flight, starting them in order.
 *
 * After a failure nothing new starts; the rest settle, then the first failure is rethrown.
 *
 * @helper forEachLimited
 */
export async function forEachLimited<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | undefined;
	await Promise.all(Array.from({ length: Math.max(1, limit) }, async () => {
		while (next < items.length && !failure) {
			const i = next++;
			try { await work(items[i], i); } catch (error) { failure ??= { error }; }
		}
	}));
	if (failure) { throw failure.error; }
}
