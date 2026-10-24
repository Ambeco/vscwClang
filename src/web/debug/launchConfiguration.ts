/** The configuration F5 uses when there is no launch.json, and the one offered when creating one. */
export const DEFAULT_LAUNCH = { type: 'vscwclang', request: 'launch', name: 'Debug C++ (vscwClang)', program: '.vscwclang/debug/a.out.wasm' } as const;

/**
 * Fills in what a vscwclang launch configuration leaves out.
 *
 * An empty configuration (F5 with no launch.json) becomes `DEFAULT_LAUNCH`; without this VS Code starts nothing.
 * With the program in a terminal (the default `console`), `internalConsoleOptions` defaults to `neverOpen`, because
 * VS Code otherwise brings the empty Debug Console to the front over the program's terminal.
 */
export function resolveLaunchConfiguration(config: Record<string, unknown>): Record<string, unknown> {
	const resolved: Record<string, unknown> = !config.type && !config.request && !config.name ? { ...DEFAULT_LAUNCH, ...config } : { ...config };
	if (resolved.console !== 'internalConsole' && resolved.internalConsoleOptions === undefined) { resolved.internalConsoleOptions = 'neverOpen'; }
	return resolved;
}
