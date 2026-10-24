/**
 * Where the archive keeps its content: one folder under `/archive` per kind of node it owns.
 * They are the `roots` in `mod.json`, which `mod setup` creates; `test/roots.test.ts` keeps the
 * two lists together. Import-free but for `@ein/paths`, so pages, bins and other modules can
 * import it.
 */
import { ARCHIVE_PATH } from '@ein/paths';

export const ALBUMS_ROOT = `${ARCHIVE_PATH}/albums`;
export const PEOPLE_ROOT = `${ARCHIVE_PATH}/people`;
/** Locations (`location` nodes) live under this prefix. */
export const LOCATIONS_ROOT = `${ARCHIVE_PATH}/locations`;
/** Devices live under this prefix; a device's recorded route is its child `track`. */
export const DEVICES_ROOT = `${ARCHIVE_PATH}/devices`;

/**
 * Whether `path` lies in the library: under `ALBUMS_ROOT`. A copy of a staged file is "already in
 * the library" only there, not in a home or another tree.
 */
export const isLibraryPath = (path: string): boolean => path.startsWith(`${ALBUMS_ROOT}/`);
