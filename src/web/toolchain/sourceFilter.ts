import { stripWorkspaceFolder } from './guestPaths';

/** Directory names skipped by default when looking for sources: IDE scratch folders, build output and VCS metadata. */
const DEFAULT_EXCLUDED_DIRS = ['node_modules', '.git', '.vscwclang', '.vs', 'enc_temp_folder', 'Debug', 'Release', 'x64', 'x86', 'build', 'out', 'dist', 'CMakeFiles', '.cache'];

/** The default of `vscwclang.files.exclude`, in the glob-object shape of cpptools' `C_Cpp.files.exclude`. */
export const DEFAULT_EXCLUDE: Readonly<Record<string, boolean>> = Object.fromEntries(DEFAULT_EXCLUDED_DIRS.map(d => [`**/${d}`, true]));

function globToRegExp(glob: string): RegExp {
	const segments = stripWorkspaceFolder(glob.replace(/\\/g, '/')).replace(/^(\.\/|\/)+/, '').split('/').filter(s => s !== '');
	let source = '';
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1;
		if (segment === '**') { source += last ? '.*' : '(?:.*/)?'; return; }
		let braces = 0;
		for (const ch of segment) {
			if (ch === '*') { source += '[^/]*'; }
			else if (ch === '?') { source += '[^/]'; }
			else if (ch === '{') { braces++; source += '(?:'; }
			else if (ch === '}' && braces > 0) { braces--; source += ')'; }
			else if (ch === ',' && braces > 0) { source += '|'; }
			else { source += ch.replace(/[.+^$()|[\]\\]/g, '\\$&'); }
		}
		source += ')'.repeat(braces) + (last ? '' : '/');
	});
	return new RegExp(`^${source}$`, 'i');
}

/**
 * A predicate telling whether a path (relative to the workspace folder) is excluded by a `files.exclude`-style
 * object, as in cpptools' `C_Cpp.files.exclude`: keys are globs relative to the workspace folder (`**`, `*`, `?`,
 * `{a,b}`), a `true` value excludes and anything else (`false`, VS Code's `when` objects) does not.
 *
 * A path is excluded if the glob matches it or any directory above it, so `**` + `/build` skips everything under
 * any `build` folder. Matching ignores case, since the folders being skipped often come from Windows tools.
 */
export function makeSourceExcluder(exclude: Readonly<Record<string, unknown>>): (relativePath: string) => boolean {
	const patterns = Object.entries(exclude).filter(([, v]) => v === true).map(([glob]) => globToRegExp(glob));
	if (patterns.length === 0) { return () => false; }
	return relativePath => {
		const segments = relativePath.split(/[\\/]/).filter(s => s !== '');
		for (let n = 1; n <= segments.length; n++) {
			const prefix = segments.slice(0, n).join('/');
			if (patterns.some(p => p.test(prefix))) { return true; }
		}
		return false;
	};
}
