import * as assert from 'assert';
import { describeUnsupportedImports } from '../../toolchain/wasiImports';

suite('describeUnsupportedImports', () => {
	test('ordinary WASI imports are fine', () => {
		assert.strictEqual(describeUnsupportedImports([{ module: 'wasi_snapshot_preview1', name: 'fd_write' }, { module: 'env', name: 'memory' }]), undefined);
	});

	test('fd_fdstat_set_rights is reported with a suggestion', () => {
		const m = describeUnsupportedImports([{ module: 'wasi_snapshot_preview1', name: 'fd_write' }, { module: 'wasi_snapshot_preview1', name: 'fd_fdstat_set_rights' }]);
		assert.match(m ?? '', /fd_fdstat_set_rights/);
		assert.match(m ?? '', /Did you mean/);
	});

	test('same name in another module is not reported', () => {
		assert.strictEqual(describeUnsupportedImports([{ module: 'env', name: 'fd_fdstat_set_rights' }]), undefined);
	});
});
