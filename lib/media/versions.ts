/**
 * Versions: other forms of a picture kept under it as `<file>/versions/<name>`, such as a camera RAW
 * beside its JPEG or the master a scan's picture was made from (`@archive/media/versions`). A
 * version is frozen and carries the picture's id as `sourceId`: no pipeline indexes it, search and
 * albums leave it out, and it stays on the durable disk tier.
 */

import type { Command } from '@ein/client';
import { REGION_TYPE, type RegionAttrs, regionsPathOf } from '@archive/media/regions';
import { releasePerson } from '@archive/people/person';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The directory under a picture that holds its versions. */
export const VERSIONS_DIR = 'versions';

/**
 * The attr on a picture naming the files its sidecar says it was made from that are not yet filed
 * under it as versions, as they have not landed beside it (`@archive/media/sidecars`).
 */
export const PENDING_VERSIONS_ATTR = 'pendingVersions';

/** Delete the regions on `filePath` and tidy the people they named; returns how many went. */
export const dropRegions = async (vfs: Vfs, access: Access, filePath: string): Promise<number> => {
  const regionsPath = regionsPathOf(filePath);
  if (!await vfs.exists(access, regionsPath)) return 0;
  const entries = await vfs.children<RegionAttrs>(access, regionsPath, { follow: false });
  const regions = entries.filter((entry) => entry.node.type === REGION_TYPE);
  const gone = new Map<string, Set<string>>();
  for (const { node } of regions) {
    const personId = node.attrs.personId;
    if (personId) gone.set(personId, (gone.get(personId) ?? new Set()).add(node.id));
  }
  await vfs.unlink(access, regionsPath, filePath, { recursive: true });
  for (const [personId, ids] of gone) await releasePerson(vfs, access, personId, ids);
  return regions.length;
};

/**
 * Move the file at `from` under the picture at `picture` (whose id is `pictureId`) as a version of
 * the same name, and drop its regions, since a face on it is the picture's too. Refuses a name
 * already taken there, leaving the file where it was. Returns the version's path.
 */
export const fileVersion = async (vfs: Vfs, access: Access, from: string, picture: string, pictureId: string): Promise<string> => {
  const name = from.slice(from.lastIndexOf('/') + 1);
  const dest = `${picture}/${VERSIONS_DIR}/${name}`;
  await vfs.ensure(access, 'directory', picture, VERSIONS_DIR, { props: { mode: 0o770 } });
  // Marked before it moves, both attrs in one update, so it is never a loose file under the picture
  // and never transiently on the volatile tier (sourceId without frozen).
  await vfs.update(access, from, { attrs: { sourceId: pictureId, frozen: true } });
  const [moved] = await vfs.renameMany(access, [{ from, to: dest }], { failIfExists: true, relink: true });
  if (moved.status === 'rejected') {
    await vfs.update(access, from, { attrs: { sourceId: null, frozen: null } });
    throw moved.reason;
  }
  await dropRegions(vfs, access, dest);
  return dest;
};
