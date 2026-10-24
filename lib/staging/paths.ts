/**
 * The shape of a staging area, and the only place that knows it (`@archive/staging/paths`).
 *
 * ```
 * /home/<user>/staging/
 *   files/<category>/…        staged files, in any tree of batch folders under their category
 *   albums/<category>/<slug>  the category's suggested groups
 *   albums/<category>/.organizer, .request
 *                             the organizer's checkpoint, and a request for a run of it
 *   journal/                  decisions made in staging
 *   routes/                   GPX files waiting for the device that recorded them
 * ```
 *
 * Pure and import-free but for `@ein/paths`, so pages, bins and other modules can import it.
 */
import { homePath as homeOf, HOMES_PATH } from '@ein/paths';

/** The category every staging area has, which cannot be removed: where uploads go by default. */
export const DEFAULT_CATEGORY = 'inbox';

/** What `staging category --create` accepts as a category's name; one adopted by `staging init` keeps its own. */
export const CATEGORY_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** The mode of every directory of a staging area: its owner's alone. */
export const STAGING_MODE = 0o700;

/** The organizer's checkpoint in a category's directory of groups: no group, so a dot name. */
export const ORGANIZER_CHECKPOINT = '.organizer';

/** A request for an organizer run of the category, in its directory of groups: written by whoever may write there. */
export const ORGANIZER_REQUEST = '.request';

/** The directories directly under `staging/`, each made by `staging init`. */
export const STAGING_DIRS = ['files', 'albums', 'journal', 'routes'] as const;

type StagingRoots = {
  homePath: string;
  stagingPath: string;
  filesPath: string;
  albumsPath: string;
  journalPath: string;
  routesPath: string;
};

const USER_NAME = /^[A-Za-z0-9._@+-]+$/;

/** Where `user`'s staging area and its directories are. Throws for a name that is not one path segment. */
export const stagingRoots = (user: string): StagingRoots => {
  if (!USER_NAME.test(user) || user === '.' || user === '..') throw new Error(`invalid username '${user}'`);
  const homePath = homeOf(user);
  const stagingPath = `${homePath}/staging`;
  return {
    homePath,
    stagingPath,
    filesPath: `${stagingPath}/files`,
    albumsPath: `${stagingPath}/albums`,
    journalPath: `${stagingPath}/journal`,
    routesPath: `${stagingPath}/routes`,
  };
};

/** The directory of `user`'s category `slug`, which holds its staged files. */
export const categoryPath = (user: string, slug: string): string => `${stagingRoots(user).filesPath}/${slug}`;

/** The directory of `user`'s category `slug`'s suggested groups. */
export const categoryAlbumsPath = (user: string, slug: string): string => `${stagingRoots(user).albumsPath}/${slug}`;

/** Where a browser upload into the category at `category` lands on `day` (`YYYY-MM-DD`). */
export const uploadPathFor = (category: string, day: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid day '${day}'`);
  return `${category}/upload-${day}`;
};

/** Whether a folder's name is that of a folder browser uploads land in (`uploadPathFor`). */
export const isUploadFolder = (name: string): boolean => /^upload-\d{4}-\d{2}-\d{2}$/.test(name);

/** Which part of a staging area a path is in: one of `STAGING_DIRS`, the staging directory itself, or anything else under it. */
type StagingArea = typeof STAGING_DIRS[number] | 'root' | 'other';

/**
 * A path at or under a staging area, taken apart. `category` is the first segment under `files/`
 * or `albums/`, and `rest` what follows it (`''` for the category directory itself); in any other
 * area `rest` is what follows the area's directory.
 */
type StagedPath = { user: string; area: StagingArea; category?: string; rest: string };

const STAGED = new RegExp(`^${HOMES_PATH}/([^/]+)/staging(?:/([^/]+)(?:/(.*))?)?$`);

/** `path` taken apart (`StagedPath`), or undefined for a path outside every staging area. */
export const parseStagedPath = (path: string): StagedPath | undefined => {
  const match = path.replace(/\/+$/, '').match(STAGED);
  if (!match) return undefined;
  const [, user, dir, below = ''] = match;
  if (dir === undefined) return { user, area: 'root', rest: '' };
  const area = (STAGING_DIRS as readonly string[]).includes(dir) ? dir as StagingArea : 'other';
  if ((area === 'files' || area === 'albums') && below !== '') {
    const slash = below.indexOf('/');
    return slash < 0 ? { user, area, category: below, rest: '' } : { user, area, category: below.slice(0, slash), rest: below.slice(slash + 1) };
  }
  return { user, area, rest: below };
};

/** Whose category a staged entry is in: anything within a category directory under `files/`, at any depth. */
export const stagedPlace = (path: string): { user: string; category: string } | undefined => {
  const parsed = parseStagedPath(path);
  return parsed?.area === 'files' && parsed.category !== undefined && parsed.rest !== '' ? { user: parsed.user, category: parsed.category } : undefined;
};

/** Whether `path` is staged: anything under `files/`, a category or not. */
export const isStagedPath = (path: string): boolean => {
  const parsed = parseStagedPath(path);
  return parsed?.area === 'files' && parsed.category !== undefined;
};

/** Whether `path` is a suggested group: `albums/<category>/<slug>`, its slug not a dot name. */
export const isStagingGroup = (path: string): boolean => {
  const parsed = parseStagedPath(path);
  return parsed?.area === 'albums' && parsed.category !== undefined && /^[^./][^/]*$/.test(parsed.rest);
};

/** The suggested group `path` is or lies under, or undefined when it is in none. */
export const stagingGroupOf = (path: string): string | undefined => {
  const parsed = parseStagedPath(path);
  if (parsed?.area !== 'albums' || parsed.category === undefined || parsed.rest === '') return undefined;
  const slug = parsed.rest.split('/')[0];
  return slug.startsWith('.') ? undefined : `${categoryAlbumsPath(parsed.user, parsed.category)}/${slug}`;
};

/**
 * The directory of the suggested groups a staged file can join: its category's in `albums/`, or
 * undefined for a path not within a category.
 */
export const groupsDirOf = (path: string): string | undefined => {
  const place = stagedPlace(path);
  return place && categoryAlbumsPath(place.user, place.category);
};
