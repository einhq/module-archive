import { NON_MEMBER_LINK_NAMES } from '@ein/paths';
import { ALBUMS_ROOT } from '@archive/paths';
import { parseStagedPath, stagingGroupOf } from '@archive/staging/paths';
import { isDirectory, isMediaFile, type NodeChildEntry } from '@ein/ui/lib';

/**
 * The album a media file belongs to, derived from its path.
 *
 * The whole path, not the slug: the album route hands its `:id` straight to `ls`,
 * so a bare slug is resolved relative to the shell's cwd and lands under
 * `/home/<user>/`. Files outside the albums root have no album, which is the
 * answer a caller wants — the lightbox hides its album button rather than
 * guessing.
 */
const SHARED_ALBUM = new RegExp(`^${ALBUMS_ROOT}/([^/]+)/`);

export function albumPathOf(filePath: string): string | undefined {
  const shared = filePath.match(SHARED_ALBUM);
  if (shared) return `${ALBUMS_ROOT}/${shared[1]}`;
  const group = stagingGroupOf(filePath);
  return group && group !== filePath ? group : undefined;
}

/**
 * The Sort stream's route to one of `user`'s own suggested groups
 * (`/home/<user>/staging/albums/<category>/<slug>`): its category's page with the group under the
 * cursor. Undefined for any other album, another user's groups included.
 */
export function stagingGroupRoute(albumPath: string, user: string): string | undefined {
  const parsed = parseStagedPath(albumPath);
  if (!user || parsed?.user !== user || parsed.category === undefined || stagingGroupOf(albumPath) !== albumPath) return undefined;
  return `/staging?c=${encodeURIComponent(parsed.category)}&g=${encodeURIComponent(parsed.rest)}`;
}

/** The route that shows an album, with the path encoded the way the route expects. */
export const albumRoute = (albumPath: string): string => `/albums/${encodeURIComponent(albumPath)}`;

/**
 * Where an album's own media lives, given its `ls -l` listing.
 *
 * An imported album keeps its media in a lone `files/` child, so writing into
 * the album node itself would put an upload one level above every picture
 * already there. An album that holds media directly keeps its own path. `search --under` spans both, so this only decides where
 * new bytes land, not what the page shows.
 */
export function albumContentDir(albumPath: string, children: NodeChildEntry[]): string {
  const hasFilesDir = children.some((entry) => entry.name === 'files' && isDirectory(entry));
  const holdsMedia = children.some((entry) => isMediaFile(entry) || isMemberLink(entry));
  return hasFilesDir && !holdsMedia ? `${albumPath}/files` : albumPath;
}

// A file added to an album, or a member of a staging suggestion, is a softlink
// child pointing at a media file elsewhere: it makes the album non-empty without holding any file.
// The cover and the links to the album's neighbours in a series are softlinks too, and are not.
function isMemberLink(entry: NodeChildEntry): boolean {
  return entry.node.type === 'softlink' && !!entry.node.props.softlink && !NON_MEMBER_LINK_NAMES.includes(entry.name);
}
