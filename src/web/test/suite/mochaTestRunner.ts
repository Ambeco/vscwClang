// Imports mocha for the browser, defining the `mocha` global.
import 'mocha/mocha';
import * as vscode from 'vscode';

mocha.setup({
	ui: 'tdd',
	reporter: undefined
});

const startedAt = Date.now();
const stamp = () => `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;

/**
 * Prints every notification the extension host raises ("[notification] ..."), because the corner popups of the
 * visible test window are otherwise invisible to anyone reading the test output.
 */
function logNotifications(): void {
	const window = vscode.window as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const name of ['showErrorMessage', 'showWarningMessage', 'showInformationMessage']) {
		const original = window[name];
		try {
			window[name] = (...args: unknown[]) => { console.log(`${stamp()} [notification] ${name}: ${String(args[0])}`); return original.apply(vscode.window, args); };
		} catch (e) {
			console.log(`[notification] cannot log ${name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const withProgress = window['withProgress'];
	try {
		window['withProgress'] = (...args: unknown[]) => {
			const options = args[0] as { location?: unknown; title?: string };
			if (options.location === vscode.ProgressLocation.Notification) { console.log(`${stamp()} [notification] progress: ${options.title}`); }
			return withProgress.apply(vscode.window, args);
		};
	} catch (e) {
		console.log(`[notification] cannot log withProgress: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Logs calls to the APIs tests use to drive the UI when they take longer than `thresholdMs`. */
function logSlowCalls(thresholdMs = 400): void {
	const targets: [string, Record<string, unknown>, string][] = [
		['commands', vscode.commands as never, 'executeCommand'], ['workspace', vscode.workspace as never, 'openTextDocument'],
		['workspace', vscode.workspace as never, 'applyEdit'], ['window', vscode.window as never, 'showTextDocument'],
		['fs', vscode.workspace.fs as never, 'readFile'], ['fs', vscode.workspace.fs as never, 'writeFile'],
	];
	for (const [area, object, name] of targets) {
		const original = object[name] as (...args: unknown[]) => unknown;
		try {
			object[name] = function (this: unknown, ...args: unknown[]) {
				const began = Date.now();
				const result = original.apply(this, args);
				const finish = () => {
					const took = Date.now() - began;
					if (took >= thresholdMs) { console.log(`${stamp()} [slow] ${area}.${name}(${typeof args[0] === 'string' ? args[0] : String(args[0]).slice(0, 80)}) took ${took} ms`); }
				};
				if (result && typeof (result as Promise<unknown>).then === 'function') { (result as Promise<unknown>).then(finish, finish); } else { finish(); }
				return result;
			};
		} catch (e) {
			console.log(`[slow] cannot log ${area}.${name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

/** The test host shares the extension host's thread: a gap between timer ticks is time something blocked it (a wasm compile, say). */
function logStalls(intervalMs = 100, thresholdMs = 700): void {
	let last = Date.now();
	setInterval(() => {
		const now = Date.now();
		if (now - last - intervalMs >= thresholdMs) { console.log(`${stamp()} [stall] the extension host was blocked for ${now - last - intervalMs} ms`); }
		last = now;
	}, intervalMs);
}

export function run(): Promise<void> {
	logNotifications();
	logSlowCalls();
	logStalls();

	return new Promise((c, e) => {
		try {
			// Run the mocha test
			const runner = mocha.run(failures => {
				if (failures > 0) {
					e(new Error(`${failures} tests failed.`));
				} else {
					c();
				}
			});
			runner.on('test', test => console.log(`${stamp()} [test] start: ${test.fullTitle()}`));
			runner.on('test end', test => console.log(`${stamp()} [test] end: ${test.title} (${test.duration ?? '?'} ms)`));
		} catch (err) {
			console.error(err);
			e(err);
		}
	});
}
