export const HEADER_EXTENSIONS = ['h', 'hh', 'hpp', 'hxx', 'h++', 'inl', 'ipp', 'tpp'];
export const SOURCE_EXTENSIONS = ['cpp', 'cc', 'cxx', 'c++', 'c', 'm', 'mm'];

function split(path: string): { dir: string[]; stem: string; ext: string } {
	const parts = path.replace(/\\/g, '/').split('/').filter(p => p.length > 0);
	const name = parts.pop() ?? '';
	const dot = name.lastIndexOf('.');
	return { dir: parts, stem: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}

/**
 * The header for a source file or the source for a header, chosen from `files` (workspace-relative paths).
 *
 * Only files with the same stem and the opposite kind qualify. The closest wins: same folder first, then the most shared
 * leading or trailing folders (so `include/foo/a.h` pairs with `src/foo/a.cpp` over an unrelated `other/a.cpp`), then the earlier
 * entry of the extension lists (`.h` before `.hpp`; `.cpp` before `.c`). Ties go to the shorter, then alphabetical, path.
 */
export function pickCounterpart(current: string, files: readonly string[]): string | undefined {
	const here = split(current);
	const wantHeader = SOURCE_EXTENSIONS.includes(here.ext);
	if (!wantHeader && !HEADER_EXTENSIONS.includes(here.ext)) { return undefined; }
	const wanted = wantHeader ? HEADER_EXTENSIONS : SOURCE_EXTENSIONS;
	const scored: { path: string; shared: number; ext: number; sameDir: number }[] = [];
	for (const file of files) {
		const other = split(file);
		const ext = wanted.indexOf(other.ext);
		if (ext < 0 || other.stem !== here.stem) { continue; }
		let prefix = 0;
		while (prefix < here.dir.length && prefix < other.dir.length && here.dir[prefix] === other.dir[prefix]) { prefix++; }
		let suffix = 0;
		while (suffix < here.dir.length && suffix < other.dir.length && here.dir[here.dir.length - 1 - suffix] === other.dir[other.dir.length - 1 - suffix]) { suffix++; }
		const shared = Math.max(prefix, suffix);
		scored.push({ path: file, shared, ext, sameDir: here.dir.length === other.dir.length && shared === here.dir.length ? 1 : 0 });
	}
	scored.sort((a, b) => b.sameDir - a.sameDir || b.shared - a.shared || a.ext - b.ext || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
	return scored[0]?.path;
}
