import * as assert from 'assert';
import * as vscode from 'vscode';
import { IndexSweep, type NotificationSender } from '../../clangd/indexSweep';

/**
 * Exercises `IndexSweep`'s open/close bookkeeping without a real clangd process: a fake `NotificationSender`
 * just records what would have been sent over the wire, which is enough to check the race this class exists
 * to avoid (documents/remaining_work.md "V3 idea: clangd"): a file the sweep fake-opened must be closed, with
 * no duplicate open, the instant a real editor opens it, and never closed again afterwards.
 */
suite('vscwClang IndexSweep', function () {
	this.timeout(20_000);

	let dir: vscode.Uri;
	const encoder = new TextEncoder();
	const log = vscode.window.createOutputChannel('vscwclang-indexsweep-test');

	suiteSetup(async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(folder, 'run with a workspace folder (npm test passes one)');
		dir = vscode.Uri.joinPath(folder, 'indexsweep-test');
		await vscode.workspace.fs.createDirectory(dir);
	});

	suiteTeardown(async () => {
		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	});

	test('a real open during fake-indexing closes the fake copy exactly once, with no duplicate open', async () => {
		const file = vscode.Uri.joinPath(dir, 'race.cpp');
		await vscode.workspace.fs.writeFile(file, encoder.encode('int main() { return 0; }\n'));

		const calls: { method: string; uri: string }[] = [];
		const sender: NotificationSender = {
			sendNotification: (type, params) => {
				calls.push({ method: type.method, uri: (params as { textDocument: { uri: string } }).textDocument.uri });
				return Promise.resolve();
			},
		};
		const code2Protocol = (uri: vscode.Uri) => uri.toString();
		const sweep = new IndexSweep(sender, code2Protocol, log, { holdOpenMs: 2_000, pauseMs: 0 });

		try {
			sweep.enqueue([file]);
			sweep.start();
			// Let the sweep send its fake didOpen and settle into its holdOpenMs wait.
			await new Promise(r => setTimeout(r, 200));
			assert.deepStrictEqual(calls, [{ method: 'textDocument/didOpen', uri: code2Protocol(file) }],
				'sweep should have fake-opened the file by now');

			// Simulate the real editor opening the same file while the sweep still holds its fake copy open.
			const doc = await vscode.workspace.openTextDocument(file);
			await sweep.willRealOpen(doc);
			assert.deepStrictEqual(calls, [
				{ method: 'textDocument/didOpen', uri: code2Protocol(file) },
				{ method: 'textDocument/didClose', uri: code2Protocol(file) },
			], 'the real open should have closed the fake copy immediately, before any real didOpen is sent');

			// The sweep's own close step (after holdOpenMs) must see the file is now really open and do nothing.
			await new Promise(r => setTimeout(r, 2_200));
			assert.deepStrictEqual(calls, [
				{ method: 'textDocument/didOpen', uri: code2Protocol(file) },
				{ method: 'textDocument/didClose', uri: code2Protocol(file) },
			], 'the sweep must never close a file a real editor still has open');
		} finally {
			sweep.dispose();
		}
	});

	test('enqueue after the loop has gone idle is still processed (the loop restarts rather than staying dead)', async () => {
		const fileA = vscode.Uri.joinPath(dir, 'restart-a.cpp');
		const fileB = vscode.Uri.joinPath(dir, 'restart-b.cpp');
		await vscode.workspace.fs.writeFile(fileA, encoder.encode('int a() { return 0; }\n'));
		await vscode.workspace.fs.writeFile(fileB, encoder.encode('int b() { return 0; }\n'));

		const calls: { method: string; uri: string }[] = [];
		const sender: NotificationSender = {
			sendNotification: (type, params) => {
				calls.push({ method: type.method, uri: (params as { textDocument: { uri: string } }).textDocument.uri });
				return Promise.resolve();
			},
		};
		const code2Protocol = (uri: vscode.Uri) => uri.toString();
		const sweep = new IndexSweep(sender, code2Protocol, log, { holdOpenMs: 10, pauseMs: 0 });
		try {
			sweep.enqueue([fileA]);
			sweep.start();
			await sweep.waitUntilIdle();
			assert.deepStrictEqual(calls, [
				{ method: 'textDocument/didOpen', uri: code2Protocol(fileA) },
				{ method: 'textDocument/didClose', uri: code2Protocol(fileA) },
			], 'the first file should have been fake-indexed before the loop went idle');

			// The loop has already returned at this point; enqueue must restart it, not just add dead work.
			sweep.enqueue([fileB]);
			await sweep.waitUntilIdle();
			assert.deepStrictEqual(calls, [
				{ method: 'textDocument/didOpen', uri: code2Protocol(fileA) },
				{ method: 'textDocument/didClose', uri: code2Protocol(fileA) },
				{ method: 'textDocument/didOpen', uri: code2Protocol(fileB) },
				{ method: 'textDocument/didClose', uri: code2Protocol(fileB) },
			], 'enqueue after the loop went idle should still get the file indexed');
		} finally {
			sweep.dispose();
		}
	});

	// A test for the re-queue-on-real-close path (onRealClose) is intentionally not included here: under
	// `vscode-test-web`, closing the only editor showing a document opened via `openTextDocument` does not
	// reliably fire `onDidCloseTextDocument` within any reasonable test timeout (tried both
	// `closeActiveEditor` and `closeAllEditors`, polling up to 8s), so the test was flaky on environment
	// timing rather than on the behavior under test. The underlying bug this file's tests exist to catch (the
	// sweep loop going idle and staying dead) is covered by the "enqueue after the loop has gone idle" test
	// above, which exercises the same `wake()` path `onRealClose` also uses.

	test('a file in the same folder as a really-open document jumps ahead of one queued earlier elsewhere', async () => {
		const nearDir = vscode.Uri.joinPath(dir, 'near');
		const farDir = vscode.Uri.joinPath(dir, 'far');
		await vscode.workspace.fs.createDirectory(nearDir);
		await vscode.workspace.fs.createDirectory(farDir);
		const realFile = vscode.Uri.joinPath(nearDir, 'open.cpp');
		const nearFile = vscode.Uri.joinPath(nearDir, 'sibling.cpp');
		const farFile1 = vscode.Uri.joinPath(farDir, 'unrelated1.cpp');
		const farFile2 = vscode.Uri.joinPath(farDir, 'unrelated2.cpp');
		await vscode.workspace.fs.writeFile(realFile, encoder.encode('int open_() { return 0; }\n'));
		await vscode.workspace.fs.writeFile(nearFile, encoder.encode('int sibling() { return 0; }\n'));
		await vscode.workspace.fs.writeFile(farFile1, encoder.encode('int unrelated1() { return 0; }\n'));
		await vscode.workspace.fs.writeFile(farFile2, encoder.encode('int unrelated2() { return 0; }\n'));

		const calls: { method: string; uri: string }[] = [];
		const sender: NotificationSender = {
			sendNotification: (type, params) => {
				calls.push({ method: type.method, uri: (params as { textDocument: { uri: string } }).textDocument.uri });
				return Promise.resolve();
			},
		};
		const code2Protocol = (uri: vscode.Uri) => uri.toString();
		const sweep = new IndexSweep(sender, code2Protocol, log, { holdOpenMs: 300, pauseMs: 0 });
		try {
			// farFile1/farFile2 are enqueued first, and enqueue()'s wake() starts the loop on farFile1 right
			// away (nothing else is queued yet). While farFile1 is held open, the near/ folder becomes "hot"
			// via a real open, and nearFile is enqueued. Despite being queued last, nearFile should still beat
			// farFile2, since it shares a folder with a currently-open real document.
			sweep.enqueue([farFile1, farFile2]);
			const doc = await vscode.workspace.openTextDocument(realFile);
			await sweep.willRealOpen(doc);
			sweep.enqueue([nearFile]);
			await sweep.waitUntilIdle();
			const opens = calls.filter(c => c.method === 'textDocument/didOpen').map(c => c.uri);
			assert.deepStrictEqual(opens, [code2Protocol(farFile1), code2Protocol(nearFile), code2Protocol(farFile2)],
				'the same-folder-as-open file should jump ahead of the other far file, but not the one already in flight');
		} finally {
			sweep.dispose();
		}
	});

	test('config-tier files go first, a queued file is moved up, and progress is reported and then reset', async () => {
		const names = ['t1', 't2', 't3', 't4'];
		const files = names.map(n => vscode.Uri.joinPath(dir, `${n}.cpp`));
		for (const f of files) { await vscode.workspace.fs.writeFile(f, encoder.encode('int f() { return 0; }\n')); }
		const calls: string[] = [];
		const sender: NotificationSender = {
			sendNotification: (type, params) => {
				if (type.method === 'textDocument/didOpen') { calls.push((params as { textDocument: { uri: string } }).textDocument.uri); }
				return Promise.resolve();
			},
		};
		const sweep = new IndexSweep(sender, uri => uri.toString(), log, { holdOpenMs: 100, pauseMs: 0 });
		const progress: { done: number; total: number }[] = [];
		sweep.onDidChangeProgress(p => progress.push(p));
		try {
			sweep.enqueue([files[0]]); // starts immediately and is held open
			sweep.enqueue([files[1], files[2], files[3]]);
			sweep.enqueue([files[3]], 'config'); // already queued: moved to the front
			await sweep.waitUntilIdle();
			assert.deepStrictEqual(calls, [files[0], files[3], files[1], files[2]].map(f => f.toString()));
			assert.deepStrictEqual(progress[progress.length - 1], { done: 4, total: 4 });
			sweep.enqueue([files[0]]);
			assert.deepStrictEqual(progress[progress.length - 1], { done: 0, total: 1 }, 'counters reset once idle');
			await sweep.waitUntilIdle();
		} finally {
			sweep.dispose();
		}
	});

	test('with enabled false nothing is sent, and the work is kept until enabled', async () => {
		const file = vscode.Uri.joinPath(dir, 'disabled.cpp');
		await vscode.workspace.fs.writeFile(file, encoder.encode('int f() { return 0; }\n'));
		const calls: string[] = [];
		const sender: NotificationSender = { sendNotification: type => { calls.push(type.method); return Promise.resolve(); } };
		const options = { holdOpenMs: 10, pauseMs: 0, enabled: false };
		const sweep = new IndexSweep(sender, uri => uri.toString(), log, options);
		try {
			sweep.enqueue([file]);
			await sweep.waitUntilIdle();
			assert.deepStrictEqual(calls, []);
			options.enabled = true;
			sweep.start();
			await sweep.waitUntilIdle();
			assert.deepStrictEqual(calls, ['textDocument/didOpen', 'textDocument/didClose']);
		} finally {
			sweep.dispose();
		}
	});

	test('enqueue skips a file that is already really open', async () => {
		const file = vscode.Uri.joinPath(dir, 'already-open.cpp');
		await vscode.workspace.fs.writeFile(file, encoder.encode('int main() { return 0; }\n'));
		await vscode.workspace.openTextDocument(file);

		const calls: { method: string }[] = [];
		const sender: NotificationSender = {
			sendNotification: type => { calls.push({ method: type.method }); return Promise.resolve(); },
		};
		const sweep = new IndexSweep(sender, uri => uri.toString(), log, { holdOpenMs: 50, pauseMs: 0 });
		try {
			sweep.enqueue([file]);
			sweep.start();
			await sweep.waitUntilIdle();
			assert.deepStrictEqual(calls, [], 'a file already open in a real editor must never be fake-opened');
		} finally {
			sweep.dispose();
		}
	});
});
