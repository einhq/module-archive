/**
 * Folders below a category, as the Files tab and its move dialog name them: a `dir` is the path
 * below the category's directory, `''` for the category itself. Pure, so the paths a move is sent
 * to are tested without a page.
 */

/** `dir` as the page uses it: its segments joined by `/`, with empty, `.` and `..` segments left out. */
export const cleanDir = (dir: string | null | undefined): string =>
  (dir ?? '').split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..').join('/');

/** The directory `dir` names below the category at `categoryPath`. */
export const folderPath = (categoryPath: string, dir: string): string => {
  const clean = cleanDir(dir);
  return clean === '' ? categoryPath : `${categoryPath}/${clean}`;
};

/** The `dir` of `path` below the category at `categoryPath`, or undefined for a path outside it. */
export const dirOf = (categoryPath: string, path: string): string | undefined => {
  if (path === categoryPath) return '';
  return path.startsWith(`${categoryPath}/`) ? cleanDir(path.slice(categoryPath.length + 1)) : undefined;
};

/** The folder above `dir`; the category's own `''` has none and stays. */
export const parentDir = (dir: string): string => cleanDir(dir).split('/').slice(0, -1).join('/');

/** Each folder on the way down to `dir`, as a name and the `dir` that opens it; none for the category itself. */
export const crumbs = (dir: string): { name: string; dir: string }[] => {
  const segments = cleanDir(dir).split('/').filter(Boolean);
  return segments.map((name, index) => ({ name, dir: segments.slice(0, index + 1).join('/') }));
};

const at = (path: string, under: string): boolean => path === under || path.startsWith(`${under}/`);

/**
 * Why `sources` cannot be moved into the directory `target`, or undefined when they can:
 * `into-itself` when the target is one of them or below one, `already-there` when every one of
 * them is in it already.
 */
export const moveBlocked = (target: string, sources: readonly string[]): 'into-itself' | 'already-there' | undefined => {
  if (sources.some((source) => at(target, source))) return 'into-itself';
  if (sources.length > 0 && sources.every((source) => source.slice(0, source.lastIndexOf('/')) === target)) return 'already-there';
  return undefined;
};

/** Whether `name` can be a new folder's name: one path segment, not `.` or `..`. */
export const isFolderName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !name.includes('/');
