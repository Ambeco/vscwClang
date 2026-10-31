import * as assert from 'assert';
import { ClangdStatus, statusLabel, type StatusItem } from '../../clangd/clangdStatus';

function fakeItem() {
	const item = { text: '', tooltip: undefined as unknown, visible: false, show() { this.visible = true; }, hide() { this.visible = false; } };
	return item satisfies StatusItem;
}

suite('clangdStatus', () => {
	test('idle and unknown states show nothing; others spin with the state', () => {
		assert.strictEqual(statusLabel('idle'), undefined);
		assert.strictEqual(statusLabel(undefined), undefined);
		assert.strictEqual(statusLabel('parsing includes'), '$(sync~spin) clangd: parsing includes');
	});

	test('says "starting" until the first notification or ready()', () => {
		const item = fakeItem();
		const status = new ClangdStatus(item);
		assert.ok(item.visible);
		assert.match(item.text, /starting/);
		status.ready();
		assert.ok(!item.visible);
	});

	test('follows the active file: busy shows, idle hides, other files do not leak', () => {
		const item = fakeItem();
		const status = new ClangdStatus(item);
		status.setActive('file:///a.cpp');
		status.fileStatus('file:///a.cpp', 'parsing includes');
		assert.ok(item.visible);
		assert.match(item.text, /parsing includes/);
		status.fileStatus('file:///b.cpp', 'building preamble');
		assert.match(item.text, /parsing includes/);
		status.setActive('file:///b.cpp');
		assert.match(item.text, /building preamble/);
		status.setActive(undefined);
		assert.ok(!item.visible);
		status.setActive('file:///a.cpp');
		status.fileStatus('file:///a.cpp', 'idle');
		assert.ok(!item.visible);
	});
});
