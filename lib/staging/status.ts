/**
 * `staging status`: one user's staging area in numbers, read without writing anything. Each
 * category costs one aggregate within its directory and one read of its organizer's checkpoint;
 * the destinations one batched read; what was decided, one aggregate over the journal for every
 * category.
 */
import type { StagingAlbumRef, StagingCategoryStatus, StagingFileCounts, StagingStatus } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { nodeOwnership, SYSTEM_TIME_ZONE, verifyAccess } from '@ein/client';
import { CATEGORY_ATTR, type CategoryEntry, readCategories } from '@archive/staging/category';
import { journalTotals } from '@archive/staging/journal';
import { readOrganizerSummary } from '@archive/staging/organizer';
import { categoryAlbumsPath, DEFAULT_CATEGORY, stagingRoots, uploadPathFor } from '@archive/staging/paths';
import { basename } from '@std/path';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The mimetype prefixes (six characters, as the aggregate groups them) of what counts as media. */
const MEDIA_PREFIXES = new Set(['image/', 'video/', 'audio/']);

/** `at`'s calendar day in the archive's time zone, `YYYY-MM-DD`. */
const archiveDay = (at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: SYSTEM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/**
 * The staged originals within `path` counted by kind, in one aggregate, with `user`'s exact copies
 * and look-alikes among them. A derived file (a rendition, a version) is not an original, and a file's own
 * children are not within the category. An empty media file is never indexed, and neither is a
 * deferred exact copy, so neither counts as waiting for it.
 */
const countCategory = async (vfs: Vfs, access: Access, user: string, path: string): Promise<StagingFileCounts> => {
  const findingsOf = (kind: string, where: string) => [
    { ref: { path: ['duplicate', 'inbox'] }, op: 'eq' as const, value: user },
    { ref: { path: ['duplicate', 'kind'] }, op: 'eq' as const, value: kind },
    { ref: { path: ['duplicate', 'where'] }, op: 'eq' as const, value: where },
  ];
  const buckets = await vfs.aggregate(access, {
    within: path,
    types: ['file'],
    where: [{ ref: 'sourceId', op: 'missing' }],
    group: [{ ref: 'mimetype', prefixLength: 6 }],
    sum: 'size',
    counts: {
      indexing: [{ ref: 'indexedAt', op: 'missing' }, { ref: 'size', op: 'ne', value: 0 }, { ref: { path: ['duplicate', 'deferred'] }, op: 'missing' }],
      indexed: [{ ref: 'indexedAt', op: 'exists' }],
      undated: [{ ref: 'indexedAt', op: 'exists' }, { ref: 'takenAtUtc', op: 'missing' }],
      library: findingsOf('exact', 'library'),
      inbox: findingsOf('exact', 'inbox'),
      nearLibrary: findingsOf('near', 'library'),
      nearInbox: findingsOf('near', 'inbox'),
    },
  });
  const counts: StagingFileCounts = { files: 0, other: 0, indexing: 0, indexed: 0, undated: 0, bytes: 0, copies: { library: 0, inbox: 0 }, near: { library: 0, inbox: 0 } };
  for (const bucket of buckets) {
    counts.bytes += bucket.sum ?? 0;
    if (!MEDIA_PREFIXES.has(bucket.key[0])) {
      counts.other += bucket.count;
      continue;
    }
    counts.files += bucket.count;
    counts.indexing += bucket.counts?.indexing ?? 0;
    counts.indexed += bucket.counts?.indexed ?? 0;
    counts.undated += bucket.counts?.undated ?? 0;
    counts.copies.library += bucket.counts?.library ?? 0;
    counts.copies.inbox += bucket.counts?.inbox ?? 0;
    counts.near.library += bucket.counts?.nearLibrary ?? 0;
    counts.near.inbox += bucket.counts?.nearInbox ?? 0;
  }
  return counts;
};

/** The albums `ids` name, as references, by id; one the asker cannot see or that is gone is absent. */
export const albumRefs = async (vfs: Vfs, access: Access, ids: string[]): Promise<Map<string, StagingAlbumRef>> => {
  const refs = new Map<string, StagingAlbumRef>();
  if (ids.length === 0) return refs;
  const [nodes, paths] = await Promise.all([vfs.getNodesByIds(access, ids), vfs.resolveIdPaths(access, ids)]);
  for (const [id, node] of nodes) {
    const path = paths.get(id)?.[0];
    if (!path) continue;
    const attrs = node.attrs as { name?: string; timeStart?: string; timeEnd?: string; mediaCount?: number };
    refs.set(id, {
      id,
      path,
      title: typeof attrs.name === 'string' && attrs.name ? attrs.name : basename(path),
      ...(typeof attrs.timeStart === 'string' ? { timeStart: attrs.timeStart } : {}),
      ...(typeof attrs.timeEnd === 'string' ? { timeEnd: attrs.timeEnd } : {}),
      ...(typeof attrs.mediaCount === 'number' ? { count: attrs.mediaCount } : {}),
      ownership: nodeOwnership(node),
      writable: verifyAccess(access, node.props, 'w'),
    });
  }
  return refs;
};

/** The status of each of `categories` of `user`'s, in order. */
export const categoryStatuses = async (
  vfs: Vfs,
  access: Access,
  user: string,
  categories: CategoryEntry[],
  at = new Date(),
): Promise<StagingCategoryStatus[]> => {
  const day = archiveDay(at);
  const destinations = await albumRefs(vfs, access, [...new Set(categories.flatMap((category) => category.settings.destinationId ?? []))]);
  const decided = await journalTotals(vfs, access, user);
  const statuses: StagingCategoryStatus[] = [];
  for (const category of categories) {
    const albumsPath = categoryAlbumsPath(user, category.name);
    statuses.push({
      name: category.name,
      id: category.id,
      path: category.path,
      albumsPath,
      uploadPath: uploadPathFor(category.path, day),
      label: category.settings.label,
      kind: category.settings.kind,
      settings: category.settings,
      destination: category.settings.destinationId ? destinations.get(category.settings.destinationId) ?? null : null,
      counts: await countCategory(vfs, access, user, category.path),
      organizer: await readOrganizerSummary(vfs, access, albumsPath),
      decided: decided.get(category.name) ?? { filed: 0, discarded: 0 },
    });
  }
  return statuses;
};

/** `user`'s staging area (`StagingStatus`). */
export const stagingStatus = async (vfs: Vfs, access: Access, user: string, at = new Date()): Promise<StagingStatus> => {
  const roots = stagingRoots(user);
  const categories = await readCategories(vfs, access, user);
  const inbox = categories.find((category) => category.name === DEFAULT_CATEGORY);
  const initialized = inbox !== undefined && inbox.attrs[CATEGORY_ATTR] !== undefined &&
    await vfs.exists(access, categoryAlbumsPath(user, DEFAULT_CATEGORY));
  const routesWaiting = await vfs.childCount(access, roots.routesPath).catch(() => 0);
  return {
    user,
    initialized,
    stagingPath: roots.stagingPath,
    defaultCategory: DEFAULT_CATEGORY,
    categories: await categoryStatuses(vfs, access, user, categories, at),
    routesWaiting,
  };
};
