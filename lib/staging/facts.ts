/**
 * The bridge's staging rules: which VFS mutations make a staged file's duplicate finding
 * (`@archive/staging/duplicates`) or its dating possibly wrong, and which lane the work on a staged
 * file runs in.
 *
 * **Duplicate findings**, announced as `media.duplicates.stale` for `duplicates --record`. A
 * finding is computed for one inbox, so only a move across an inbox's edge can make it stale: a
 * file or a directory moved into an inbox from anywhere else (an upload is checked by
 * `exif-extract` instead), and a file or a directory moved into the library from outside it, whose
 * staged byte twins in every inbox may now be copies of a library file. A move inside an inbox,
 * from one category to another, announces nothing. A file whose fingerprints land is checked by
 * `compute-fingerprint` itself, so it needs no fact.
 *
 * **Dating**, announced as `staging.retime.requested` for `staging retime`. A staged file is dated
 * by its category's time rules (`StagingTimeRules`), stamped on it as `digitized` and `whenName`,
 * so a move into a category that dates by other clocks makes them wrong: a file or a directory
 * moved there from a category with other rules, a directory moved in from outside every category,
 * and a media file moved in from anywhere whose stamps disagree with its new category, announced
 * for its folder. A move within a category, or between two with the same rules, announces nothing;
 * a move out of staging neither, as the stamps go with the file.
 *
 * Decided on the event's paths first; a category is read for a move between categories (and kept
 * for a minute), and a file for one that crossed an edge (its folder too, to announce it).
 *
 * **Sidecars**, announced as `staging.sidecars.arrived` for `media-sidecars`, by folder, in a
 * category that pairs them (`sidecars: 'pair'`): a sidecar not yet paired (a Takeout JSON or an
 * XMP file) whose bytes landed (its `sha256` written) or that was moved in; a media file whose
 * bytes landed in a folder holding one still unpaired, as its photo may come after it; and a
 * directory moved in from outside the category. Whether a folder holds an unpaired sidecar is
 * asked once per ten seconds, and known at once when one lands there.
 *
 * **The organizer**, announced as `staging.category.changed` for `staging organize`, by the
 * category's directory: a staged file in it created, deleted, moved (in, out or within), or
 * updated in what grouping reads (its capture time, its reading, its faces, its camera, its type
 * and size); a GPS fix made for one; a directory moved in, out or within. Under
 * `albums/` nothing is announced but a category's request (`albums/<category>/.request`, written to
 * ask for a run, which names its own category by where it is): the organizer's own writes there,
 * its groups and its checkpoint, never are, so its runs do not start one another. The organizer
 * reads what changed from the audit trail itself; the fact only says which category. A category's
 * id is read once a minute.
 *
 * **Lanes.** Every fact the bridge announces about something in a category whose `lane` is `bulk`
 * carries `lane: 'bulk'` (`stampLanes`), so the work it starts runs below everything of the normal
 * lane. The lane is decided per fact by its subject's category, so a file moved out of a bulk
 * category has its later facts in the lane of the one it is in now. The organizer's fact names the
 * category itself, which is in no lane: its runs never wait behind a bulk category's work.
 */

import type { DomainEvent } from '@ein/client';
import { isLibraryPath } from '@archive/paths';
import { isIndexableMedia, MEDIA_EVENTS, type NodeSnapshot, type RuleContext, type VfsEventInput } from '@archive/media/event-rules';
import type { StagingCategorySettings } from '@archive/staging/api';
import { CATEGORY_ATTR, parseCategorySettings, sameTimeRules, stampsHold, timeStamps } from '@archive/staging/category';
import { SIDECAR_MIMETYPES } from '@archive/media/paired-sidecar';
import { categoryPath, ORGANIZER_REQUEST, parseStagedPath, stagedPlace } from '@archive/staging/paths';

const SOURCE = 'archive-bridge';

/** Facts the staging rules announce, beside `MEDIA_EVENTS.duplicatesStale`. */
export const STAGING_EVENTS = {
  /**
   * Staged files may be dated by another category's time rules than their own: the subject, a
   * directory, moved into a category that dates by other clocks, or a file did (`data.file`) and
   * the subject is its folder. `data.category` is the category, as `<user>/<name>`.
   */
  retimeRequested: 'staging.retime.requested',
  /**
   * A folder may hold sidecars to pair with its files: the subject, a folder of a category that
   * pairs them. `data.cause` is `sidecar` (one landed or moved in), `media` (a file landed beside
   * one unpaired) or `moved` (the subject, a directory, moved in); `data.category` is the
   * category, as `<user>/<name>`.
   */
  sidecarsArrived: 'staging.sidecars.arrived',
  /**
   * What a category's groups are planned from may have changed, or a run was asked for: the
   * subject, a category's directory. `data.cause` is `request` for a request, else the kind of
   * write; `data.category` is the category, as `<user>/<name>`.
   */
  categoryChanged: 'staging.category.changed',
} as const;

/** The routing keys these rules read, every one of them also bound by the media rules. */
export const STAGING_BRIDGE_ROUTING_KEYS = [
  'system.vfs.file.created',
  'system.vfs.file.updated',
  'system.vfs.file.deleted',
  'system.vfs.file.moved',
  'system.vfs.directory.moved',
  'system.vfs.position.created',
];

/** The attrs of a staged file grouping reads: an update of any of them may change its group. */
const GROUPING_ATTRS = new Set(['takenAt', 'takenAtUtc', 'takenAtSource', 'indexedAt', 'facesAt', 'faceCount', 'devicePath', 'mimetype', 'width', 'height', 'sourceId']);

/** How long a category's settings are believed once read, in ms. */
const SETTINGS_TTL_MS = 60_000;

/** The settings read per category path, for each rule context (the bridge keeps one). */
const settingsCache = new WeakMap<RuleContext, Map<string, { at: number; settings: StagingCategorySettings | undefined }>>();

/** A category directory's node id read per path, for each rule context. */
const categoryIds = new WeakMap<RuleContext, Map<string, { at: number; id: string | undefined }>>();

/** How long a folder's answer to "an unpaired sidecar within?" is believed, in ms. */
const UNPAIRED_TTL_MS = 10_000;

/** That answer per folder, for each rule context. */
const unpairedCache = new WeakMap<RuleContext, Map<string, { at: number; has: boolean }>>();

/** A name a sidecar has: a Takeout JSON's or an XMP packet's. */
const SIDECAR_NAME = /\.(json|xmp)$/i;

/** The owner of the staging inbox `path` lies in (under `files/`), or undefined outside every inbox. */
const inboxOf = (path: string | undefined): string | undefined => {
  if (path === undefined) return undefined;
  const parsed = parseStagedPath(path);
  return parsed?.area === 'files' && parsed.category !== undefined ? parsed.user : undefined;
};

const stale = (event: VfsEventInput, now: number, cause: string, data: Record<string, string> = {}): Omit<DomainEvent, 'id'> => ({
  type: MEDIA_EVENTS.duplicatesStale,
  subject: event.path,
  nodeId: event.nodeId,
  time: now,
  source: SOURCE,
  data: { cause, ...data },
});

/** Whether a staged file's finding already holds for inbox `user` and the bytes it has now. */
const findingHolds = (file: NodeSnapshot, user: string): boolean => {
  const finding = file.attrs.duplicate as { inbox?: unknown; sha256?: unknown } | undefined;
  return finding?.inbox === user && finding.sha256 === file.attrs.sha256;
};

/** A media file with a checksum, which is what a finding is computed from. */
const checkable = (file: NodeSnapshot | undefined): file is NodeSnapshot => file !== undefined && isIndexableMedia(file) && typeof file.attrs.sha256 === 'string';

/** The settings of category `name` of `user`, read through `ctx` and kept a minute; undefined when it is no directory. */
const settingsOf = async (ctx: RuleContext, user: string, name: string, now: number): Promise<StagingCategorySettings | undefined> => {
  const path = categoryPath(user, name);
  const cache = settingsCache.get(ctx) ?? new Map();
  settingsCache.set(ctx, cache);
  const cached = cache.get(path);
  if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.settings;
  const node = await ctx.getNode(path);
  const settings = node?.type === 'directory' ? parseCategorySettings(node.attrs[CATEGORY_ATTR], name) : undefined;
  cache.set(path, { at: now, settings });
  return settings;
};

/** The duplicate-finding facts of a file or directory move; `file` reads the moved file once. */
async function movedDuplicates(event: VfsEventInput, now: number, file: () => Promise<NodeSnapshot | undefined>): Promise<Omit<DomainEvent, 'id'>[]> {
  const inbox = inboxOf(event.path);
  if (inbox !== undefined) {
    if (inboxOf(event.fromPath) === inbox) return [];
    if (event.nodeType === 'directory') return [stale(event, now, 'moved-in')];
    const moved = await file();
    return checkable(moved) && !findingHolds(moved, inbox) ? [stale(event, now, 'moved-in', { sha256: String(moved.attrs.sha256) })] : [];
  }
  if (isLibraryPath(event.path) && !(event.fromPath !== undefined && isLibraryPath(event.fromPath))) {
    if (event.nodeType === 'directory') return [stale(event, now, 'filed')];
    const moved = await file();
    return checkable(moved) ? [stale(event, now, 'filed', { sha256: String(moved.attrs.sha256) })] : [];
  }
  return [];
}

/** The dating fact of a file or directory move into a category; `file` reads the moved file once. */
async function movedRetime(event: VfsEventInput, ctx: RuleContext, now: number, file: () => Promise<NodeSnapshot | undefined>): Promise<Omit<DomainEvent, 'id'>[]> {
  const to = stagedPlace(event.path);
  if (!to) return [];
  const from = event.fromPath === undefined ? undefined : stagedPlace(event.fromPath);
  if (from && from.user === to.user && from.category === to.category) return [];
  const rules = (await settingsOf(ctx, to.user, to.category, now))?.time;
  if (!rules) return [];
  if (from) {
    const before = (await settingsOf(ctx, from.user, from.category, now))?.time;
    if (before && sameTimeRules(before, rules)) return [];
  }
  const data = { cause: 'moved', category: `${to.user}/${to.category}` };
  if (event.nodeType === 'directory') return [{ type: STAGING_EVENTS.retimeRequested, subject: event.path, nodeId: event.nodeId, time: now, source: SOURCE, data }];
  const moved = await file();
  const slash = event.path.lastIndexOf('/');
  if (!moved || !isIndexableMedia(moved) || stampsHold(moved.attrs, timeStamps(rules, event.path.slice(slash + 1)))) return [];
  // Named by its folder, so the files of one move into it make one retime between them.
  const folder = event.path.slice(0, slash);
  const parent = await ctx.getNode(folder);
  return parent ? [{ type: STAGING_EVENTS.retimeRequested, subject: folder, nodeId: parent.id, time: now, source: SOURCE, data: { ...data, file: event.path } }] : [];
}

/** The unpaired-sidecar answers of `ctx`, by folder. */
const unpairedOf = (ctx: RuleContext): Map<string, { at: number; has: boolean }> => {
  const cache = unpairedCache.get(ctx) ?? new Map();
  unpairedCache.set(ctx, cache);
  return cache;
};

/** Whether `folder` holds an unpaired sidecar, asked through `ctx` and kept ten seconds; a context that cannot ask says no. */
const holdsUnpaired = async (ctx: RuleContext, folder: string, now: number): Promise<boolean> => {
  if (!ctx.unpairedSidecarsIn) return false;
  const cache = unpairedOf(ctx);
  const cached = cache.get(folder);
  if (cached && now - cached.at < UNPAIRED_TTL_MS) return cached.has;
  const has = await ctx.unpairedSidecarsIn(folder);
  cache.set(folder, { at: now, has });
  return has;
};

/** Whether `node` is a sidecar not yet paired. */
const unpairedSidecar = (node: NodeSnapshot | undefined): node is NodeSnapshot =>
  node?.type === 'file' && SIDECAR_MIMETYPES.includes(String(node.attrs.mimetype ?? '')) && !node.attrs.sourceId && !node.attrs.sidecar;

/** The sidecar fact of an arrival in a category that pairs sidecars; `file` reads the node once. */
async function arrivedSidecars(event: VfsEventInput, ctx: RuleContext, now: number, file: () => Promise<NodeSnapshot | undefined>): Promise<Omit<DomainEvent, 'id'>[]> {
  const to = stagedPlace(event.path);
  if (!to) return [];
  const from = event.type === 'moved' && event.fromPath !== undefined ? stagedPlace(event.fromPath) : undefined;
  const fact = (subject: string, nodeId: string, cause: string): Omit<DomainEvent, 'id'> => ({
    type: STAGING_EVENTS.sidecarsArrived,
    subject,
    nodeId,
    time: now,
    source: SOURCE,
    data: { cause, category: `${to.user}/${to.category}` },
  });
  const pairs = async () => (await settingsOf(ctx, to.user, to.category, now))?.sidecars === 'pair';

  if (event.nodeType === 'directory') {
    if (from && from.user === to.user && from.category === to.category) return [];
    return await pairs() ? [fact(event.path, event.nodeId, 'moved')] : [];
  }

  const landed = event.type === 'moved' || (event.type === 'updated' && (event.changedAttrs ?? []).includes('sha256'));
  if (!landed || !await pairs()) return [];
  const slash = event.path.lastIndexOf('/');
  const folder = event.path.slice(0, slash);
  let cause: string;
  if (SIDECAR_NAME.test(event.path)) {
    if (!unpairedSidecar(await file())) return [];
    unpairedOf(ctx).set(folder, { at: now, has: true });
    cause = 'sidecar';
  } else {
    // A rendition or anything else under a file is no arrival, and costs no query.
    if (!ctx.unpairedSidecarsIn) return [];
    const node = await file();
    if (!node || !isIndexableMedia(node) || !await holdsUnpaired(ctx, folder, now)) return [];
    cause = 'media';
  }
  const parent = await ctx.getNode(folder);
  return parent ? [fact(folder, parent.id, cause)] : [];
}

/** The node id of category `name` of `user`'s directory, read through `ctx` and kept a minute; undefined when there is none. */
const categoryIdOf = async (ctx: RuleContext, user: string, name: string, now: number): Promise<string | undefined> => {
  const path = categoryPath(user, name);
  const cache = categoryIds.get(ctx) ?? new Map();
  categoryIds.set(ctx, cache);
  const cached = cache.get(path);
  if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.id;
  const node = await ctx.getNode(path);
  const id = node?.type === 'directory' ? node.id : undefined;
  cache.set(path, { at: now, id });
  return id;
};

/** The organizer's fact of an event: for each category whose groups it may change, or that a request asks a run of. */
async function changedCategories(event: VfsEventInput, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  const places: { user: string; category: string }[] = [];
  let cause: string = event.type;
  const parsed = parseStagedPath(event.path);
  if (parsed?.area === 'albums') {
    if (event.nodeType !== 'file' || (event.type !== 'created' && event.type !== 'updated') || parsed.category === undefined || parsed.rest !== ORGANIZER_REQUEST) return [];
    places.push({ user: parsed.user, category: parsed.category });
    cause = 'request';
  } else if (event.nodeType === 'position') {
    if (event.type !== 'created') return [];
    const place = stagedPlace(event.path);
    if (place) places.push(place);
  } else if (event.nodeType === 'file' || (event.nodeType === 'directory' && event.type === 'moved')) {
    if (event.type === 'updated' && event.changedAttrs && !event.changedAttrs.some((name) => GROUPING_ATTRS.has(name))) return [];
    for (const path of [event.path, event.fromPath]) {
      const place = path === undefined ? undefined : stagedPlace(path);
      if (place && !places.some((each) => each.user === place.user && each.category === place.category)) places.push(place);
    }
  }
  const facts: Omit<DomainEvent, 'id'>[] = [];
  for (const place of places) {
    const id = await categoryIdOf(ctx, place.user, place.category, now);
    if (!id) continue;
    facts.push({
      type: STAGING_EVENTS.categoryChanged,
      subject: categoryPath(place.user, place.category),
      nodeId: id,
      time: now,
      source: SOURCE,
      data: { cause, category: `${place.user}/${place.category}` },
    });
  }
  return facts;
}

/** The staging facts a VFS event reveals. */
export async function deriveStagingFacts(event: VfsEventInput, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  return [...await changedCategories(event, ctx, now), ...await otherFacts(event, ctx, now)];
}

/** The staging facts but the organizer's a VFS event reveals. */
async function otherFacts(event: VfsEventInput, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  if (event.type === 'moved' && (event.nodeType === 'file' || event.nodeType === 'directory')) {
    let read: Promise<NodeSnapshot | undefined> | undefined;
    const file = () => read ??= ctx.getNode(event.path);
    return [...await movedDuplicates(event, now, file), ...await movedRetime(event, ctx, now, file), ...await arrivedSidecars(event, ctx, now, file)];
  }

  if (event.type === 'updated' && event.nodeType === 'file' && (event.changedAttrs ?? []).includes('sha256') && stagedPlace(event.path)) {
    let read: Promise<NodeSnapshot | undefined> | undefined;
    return await arrivedSidecars(event, ctx, now, () => read ??= ctx.getNode(event.path));
  }

  return [];
}

/**
 * `facts` with `lane: 'bulk'` on each whose subject lies in a category of the bulk lane, read
 * through `ctx` and kept a minute; the others as they are.
 */
export async function stampLanes(facts: Omit<DomainEvent, 'id'>[], ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  const stamped: Omit<DomainEvent, 'id'>[] = [];
  for (const fact of facts) {
    const place = stagedPlace(fact.subject);
    const settings = place && await settingsOf(ctx, place.user, place.category, now);
    stamped.push(settings?.lane === 'bulk' ? { ...fact, lane: 'bulk' } : fact);
  }
  return stamped;
}
