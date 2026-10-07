/** Directory names skipped by default when looking for sources: IDE scratch folders, build output and VCS metadata. */
export const DEFAULT_EXCLUDED_DIRS = ['node_modules', '.git', '.vscwclang', '.vs', 'enc_temp_folder', 'Debug', 'Release', 'x64', 'x86', 'build', 'out', 'dist', 'CMakeFiles', '.cache'];

/**
 * True if any directory segment of `relativePath` (relative to the workspace folder) is in `excludedDirs`.
 *
 * Case-insensitive, since the folders being skipped often come from Windows tools. The file name itself is
 * never matched, and the workspace folder's own name is not part of `relativePath`.
 */
export function isExcludedSource(relativePath: string, excludedDirs: readonly string[]): boolean {
	const excluded = new Set(excludedDirs.map(d => d.toLowerCase()));
	const segments = relativePath.split(/[\\/]/).filter(s => s !== '');
	return segments.slice(0, -1).some(s => excluded.has(s.toLowerCase()));
}
