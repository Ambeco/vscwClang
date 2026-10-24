import * as assert from 'assert';
import { DEFAULT_LAUNCH, resolveLaunchConfiguration } from '../../debug/launchConfiguration';

suite('resolveLaunchConfiguration', () => {
	test('F5 with no launch.json (an empty configuration) gets the default launch, with the Debug Console kept closed', () => {
		assert.deepStrictEqual(resolveLaunchConfiguration({}), { ...DEFAULT_LAUNCH, internalConsoleOptions: 'neverOpen' });
	});

	test('a configuration from launch.json is kept as written', () => {
		const config = { type: 'vscwclang', request: 'launch', name: 'mine', stopOnEntry: true };
		assert.deepStrictEqual(resolveLaunchConfiguration(config), { ...config, internalConsoleOptions: 'neverOpen' });
		assert.strictEqual('program' in resolveLaunchConfiguration(config), false, 'no default fields are mixed into a written configuration');
	});

	test('the terminal console keeps the Debug Console from covering it; an explicit choice wins', () => {
		const base = { type: 'vscwclang', request: 'launch', name: 'x' };
		assert.strictEqual(resolveLaunchConfiguration({ ...base, console: 'integratedTerminal' }).internalConsoleOptions, 'neverOpen');
		assert.strictEqual(resolveLaunchConfiguration({ ...base, internalConsoleOptions: 'openOnFirstSessionStart' }).internalConsoleOptions, 'openOnFirstSessionStart');
	});

	test('internalConsole output goes to the Debug Console, so VS Code opens it as usual', () => {
		assert.strictEqual(resolveLaunchConfiguration({ type: 'vscwclang', request: 'launch', name: 'x', console: 'internalConsole' }).internalConsoleOptions, undefined);
	});
});
