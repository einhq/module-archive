/**
 * The organizer: a category's suggested groups (`staging organize`), in which every indexed staged
 * medium of the category ends in exactly one group. A run holds the category's lock throughout.
 *
 * A **full build** plans the whole category:
 *
 * 1. **Read**: the category's files in one `within` query a page at a time; their folders, signals
 *    (GPS, people, location links) and geocodes in batched lookups by id; the groups of
 *    `albums/<category>/` and their member links; the live edits of the journal; the owner's
 *    homes, household, locations and the share of the library's faces each person has (the
 *    household and the shares only when there is media to plan). No read is made per file.
 * 2. **Plan** (`planCategory`): the groups a person pinned, or edited by hand, keep their members,
 *    which are left out; the rest are planned whole.
 * 3. **Pair** each planned group with a group there already: a lane or a seed by its key, an event,
 *    trip or run by its members (the same, or at least half in common). A group keeps its path, a
 *    name a person gave it, and its other attrs.
 * 4. **Write** only what differs: groups no plan claimed deleted, stale links unlinked, attrs
 *    rewritten, new links and groups created, each in as few calls as the VFS takes them.
 * 5. **Checkpoint** `albums/<category>/.organizer`, a db-tier JSON file of the home's owner, 0600:
 *    its attrs hold the summary `staging status` shows; its body what the next run starts from (the
 *    timeline's segments and each day's shots, the seeds, the pinned groups' members, the lanes split
 *    into months, which stay split, the edits planned with, each year's home, and where the audit
 *    trail was read to).
 *
 * An **incremental run** plans again only what changed, and gives the groups a full build would:
 *
 * 1. **What changed**: the category's audit trail read forward from the checkpoint's watermark (its
 *    files, folders, positions, faces and tags), the writes others made to its groups since the
 *    organizer's own last write (a pin, a hand-made link, a verb), and the edits made or undone.
 * 2. **What that touches**, grown until it is closed: the timeline's segments around every instant
 *    a changed file was or is at (whole segments, since no rule looks across a pause of more than
 *    two days, nor across a year's usual day, which is kept per day), the seed folders and lanes
 *    the changed files were or are in with the members those keep, and every file an edit puts
 *    with one of them.
 * 3. **Plan** those parts with the same `planCategory`, told what the rest says: which folders are
 *    seeds, the other days' shots, and which lane members stay as they are.
 * 4. **Pair and write** as a full build does, among the groups the parts held.
 *
 * The watermark lags the newest record read by ten minutes, and the records after it already
 * applied are kept, so a write whose transaction commits after a later one is still read. Both
 * move only once a run has written everything. What comes from outside the category (the owner's
 * household, each person's share of the library's faces, people's names, the named places) is
 * read by each run for the parts it plans, so a part planned again before such a change is not; and
 * each year's home stays as the last full build found it, as one found from the category's own
 * GPS needs all of a year's. A full build runs a week after the last, and on the first run, when
 * the category's grouping settings change, when asked (`--full`), when more than a fifth of the
 * category changed, and when the groups are not as the last run left them.
 */
import type {
  AutoAlbumHome,
  ClusterGroupReport,
  GroupKind,
  OrganizeFullReason,
  OrganizeResult,
  OrganizerSummary,
  StagingCategorySettings,
  StagingEdit,
  StagingQueued,
} from '@archive/staging/api';
import type { AuditRecord } from '@ein/api';
import type { Command, NodeChildEntry } from '@ein/client';
import { accessOfUser, isAdmin } from '@ein/client';
import { USERS_PATH } from '@ein/paths';
import { basename, dirname } from '@std/path';
import { getChildren, getPartners, makeCtx } from '@archive/people/genealogy';
import { isUnnamed, type PersonNodeAttrs } from '@archive/people/person';
import { NODE_TYPE_PERSON } from '@archive/people/types';
import { LOCATION_LINK_NAME, POSITION_CHILD } from '@archive/location/location-link';
import { REGIONS_DIR } from '@archive/media/regions';
import { SIDECAR_CHILD } from '@archive/media/paired-sidecar';
import {
  AUTO_ORIGIN,
  type AutoAlbumMeta,
  COVER_LINK_NAME,
  groupSpec,
  isNameLocked,
  isUserEdited,
  memberKeyOf,
  memberLinkSpecs,
  toggleMembers,
} from '@archive/staging/auto-album';
import type { CategoryEntry } from '@archive/staging/category';
import { isDeferred } from '@archive/staging/duplicates';
import { compareItems, dayOf } from '@archive/staging/cluster';
import { homesByYear } from '@archive/staging/home';
import { liveEditEntries } from '@archive/staging/journal';
import { withCategoryLock } from '@archive/staging/lock';
import { type CastMember, formatDates, groupName, laneName, momentOf, occasionOf, withGuests } from '@archive/staging/naming';
import { groupsChangedSince, matchGroups } from '@archive/staging/match';
import { idsAt } from '@archive/staging/nodes-at';
import { categoryAlbumsPath, ORGANIZER_CHECKPOINT, ORGANIZER_REQUEST, stagingRoots } from '@archive/staging/paths';
import { haversineMeters } from '@archive/staging/scoring';
import { type LocationPoint, PEOPLE_DIR, readLocations, readSignals } from '@archive/staging/signals';
import {
  classOf,
  dayShotsOf,
  isNameable,
  isSeedFolder,
  periodValue,
  type Plan,
  planCategory,
  type PlanContext,
  type PlanFolder,
  type PlanItem,
  type PlannedGroup,
  type Precision,
  type Segment,
  SEGMENT_GAP_MS,
} from '@archive/staging/strategy';
import { baselineOf } from '@archive/staging/cluster';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];
type Geo = { lat: number; lng: number };

/** The attr on the checkpoint that holds the summary. */
const SUMMARY_ATTR = 'stagingOrganizer';
/** The attr on a request for a run: when it was asked for. */
const REQUEST_ATTR = 'stagingRequest';
const CHECKPOINT_MODE = 0o600;
/** Rows read per query page, and ids per batched lookup. */
const PAGE = 1000;
/** Groups whose links are listed per call. */
const LIST_CHUNK = 500;
/** Files whose links are looked for per call. */
const LINK_CHUNK = 2000;
/** A location names a group within this distance of its photos; a named place is this far from home at least. */
const LOCATION_RADIUS_M = 500;
const PLACE_FROM_HOME_M = 1_000;
/** A share of a group's members that makes a city, a place or guests its own. */
const MAJORITY = 0.5;
const GUESTS_SHARE = 0.3;
/** A person in at most this share of the library's faces, outside the household, is a guest. */
const GUEST_FACE_SHARE = 0.005;
/** A group is provisional while more than this share of its images wait for face detection. */
const PROVISIONAL_SHARE = 0.1;
const GENERATED_BY = 'staging organize';
const MEDIA = /^(image|video|audio)\//;
/** A capture time the timeline places: an ISO instant, which also sorts as text. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far behind the newest record the watermark stays: a write committing this late is still read. */
const LAG_MS = 10 * 60 * 1000;
/** Records read past the watermark that a run keeps as applied, at most. */
const RECENT_MAX = 50_000;
/** Records read from the trail per call. */
const TRAIL_PAGE = 5_000;
/** The node types whose writes within a category can change its plan. */
const TRAIL_TYPES = ['file', 'directory', 'position', 'media-region', 'softlink'];
/** The node types whose writes within a category's groups a run looks at: the groups and their links. */
const GROUP_TRAIL_TYPES = ['album', 'softlink'];
/** Above this share of the category's media changed, a run plans it whole. */
const FULL_SHARE = 0.2;
/** …and never for fewer than this many. */
const FULL_FLOOR = 200;
/** More changed files than this within `DEFER_MS` of the last run wait for the next, unless a run was asked for. */
const DEFER_ABOVE = 2_000;
const DEFER_MS = 10 * 60 * 1000;
/** A full build runs this long after the last at the latest, to read again what an incremental run keeps. */
const FULL_EVERY_MS = 7 * DAY_MS;

/** What the checkpoint's body holds: what the next run starts from. */
type Checkpoint = {
  version: 2;
  paramsKey: string;
  granularity: Record<string, 'year' | 'month'>;
  baselines: Record<string, number>;
  /** The distinct shots of each day of the timeline. */
  dayShots: Record<string, number>;
  /** The timeline's segments, in time order. */
  segments: Segment[];
  /** The folders that are seeds. */
  seeds: string[];
  /** The member ids of each pinned group, by its node id. */
  pinned: Record<string, string[]>;
  /** Home in each year, as the last full build found it, and as runs since found it for the years it had none. */
  homes: Record<string, AutoAlbumHome>;
  /** The live edits planned with, by their journal entries' ids. */
  edits: string[];
  /** Every record of the category's trail up to this id is applied; so are `recent`, after it. */
  watermark: string;
  recent: string[];
  /** The writes to the category's groups after this id are someone else's: the organizer's own all came before. */
  groupsMark: string;
  /** The category's indexed media at the last run. */
  items: number;
  /** The groups around the days of library albums whose profiles changed after this were not matched again yet. */
  lastMatchAt: string;
  lastFullAt: string;
  lastRunAt: string;
};

/** The attrs of a staged file the organizer reads. */
type FileAttrs = {
  mimetype?: string;
  size?: number;
  indexedAt?: string;
  sourceId?: string;
  takenAt?: string;
  takenAtUtc?: string;
  takenAtSource?: string;
  width?: number;
  height?: number;
  devicePath?: string;
  facesAt?: string;
  faceCount?: number;
};

/** A staged file as the query gives it. */
export type FileRow = { id: string; path: string; attrs: FileAttrs };

/** What the organizer reads of a geocoded position. */
type Geocode = { city?: string; country?: string; poi?: string };

/** Everything planning and naming read of a scope's media. */
export type ScopeMedia = {
  items: PlanItem[];
  folders: Map<string, PlanFolder>;
  /** Media not yet indexed. */
  pending: number;
  /** Every file of the scope, by path, so member links resolve without a read. */
  idOf: Map<string, string>;
  geocodes: Map<string, Geocode>;
  positionOf: Map<string, string>;
  locationOf: Map<string, string>;
};

// ── reading ─────────────────────────────────────────────────────────────────

/** Every original file within `root` (not a rendition or a sidecar), a page at a time. */
export const readScopeFiles = async (vfs: Vfs, access: Access, root: string): Promise<FileRow[]> => {
  const rows: FileRow[] = [];
  let after: { value: string | null; id: string } | undefined;
  while (true) {
    const page = await vfs.query(access, { within: root, types: ['file'], where: [{ ref: 'sourceId', op: 'missing' }], ...(after ? { after } : {}), limit: PAGE });
    for (const row of page) rows.push({ id: row.id, path: row.absPath, attrs: row.node.attrs as FileAttrs });
    if (page.length < PAGE) return rows;
    after = { value: null, id: page[page.length - 1].id };
  }
};

/** How far a capture time is known, by its wall clock's length; none for an instant that is not ISO. */
const precisionOf = (attrs: FileAttrs): Precision => {
  if (!attrs.takenAtUtc || !ISO_INSTANT.test(attrs.takenAtUtc) || !Number.isFinite(Date.parse(attrs.takenAtUtc))) return 'none';
  const wall = attrs.takenAt ?? '';
  if (/^\d{4}$/.test(wall)) return 'year';
  if (/^\d{4}-\d{2}$/.test(wall)) return 'month';
  return 'instant';
};

/** `ids` read `PAGE` at a time with `read`, the answers merged. */
const batched = async <V>(ids: string[], read: (page: string[]) => Promise<Map<string, V>>): Promise<Map<string, V>> => {
  const out = new Map<string, V>();
  for (let i = 0; i < ids.length; i += PAGE) for (const [key, value] of await read(ids.slice(i, i + PAGE))) out.set(key, value);
  return out;
};

/** Whether a staged file is media, read or not. */
const isMedia = (row: FileRow): boolean => MEDIA.test(row.attrs.mimetype ?? '');

/**
 * The indexed media of `rows` as planning items, with their folders (depth counted below `base`; 0
 * for one outside it), and unless `signals` is false their signals and geocodes: four batched
 * lookups per thousand files, whatever their number. With `anyIndexed`, media count as indexed
 * without `indexedAt`, as the library's own older media are. Without signals an item has no GPS,
 * people, location or phone folder: enough for a lane, which reads none of them.
 */
export const readMedia = async (vfs: Vfs, access: Access, rows: FileRow[], base: string, anyIndexed = false, signals = true): Promise<ScopeMedia> => {
  const idOf = new Map(rows.map((row) => [row.path, row.id]));
  const media = rows.filter(isMedia);
  const indexed = media.filter((row) => anyIndexed || row.attrs.indexedAt !== undefined);
  const pending = anyIndexed ? 0 : media.filter((row) => row.attrs.indexedAt === undefined && row.attrs.size !== 0 && !isDeferred(row.attrs)).length;

  const parents = await batched(indexed.map((row) => row.id), (page) => vfs.getParentLinksByIds(access, page));
  const folderIdOf = new Map(indexed.map((row) => [row.id, parents.get(row.id)?.[0]?.parentId ?? `dir:${dirname(row.path)}`]));
  const folderNodes = await batched([...new Set(folderIdOf.values())].filter((id) => !id.startsWith('dir:')), (page) => vfs.getNodesByIds(access, page));
  const folders = new Map<string, PlanFolder>();
  for (const row of indexed) {
    const id = folderIdOf.get(row.id)!;
    if (folders.has(id)) continue;
    const path = dirname(row.path);
    const below = path.startsWith(`${base}/`) ? path.slice(base.length + 1).split('/') : [];
    const title = (folderNodes.get(id)?.attrs as { title?: unknown } | undefined)?.title;
    folders.set(id, { id, path, name: basename(path), depth: below.length, ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}) });
  }

  const read = signals ? await readSignals(vfs, access, indexed.map((row) => row.id)) : new Map();
  const positionOf = new Map<string, string>();
  const locationOf = new Map<string, string>();
  const items = indexed.map((row): PlanItem => {
    const attrs = row.attrs;
    const signal = read.get(row.id);
    const precision = precisionOf(attrs);
    const day = typeof attrs.takenAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(attrs.takenAt) ? attrs.takenAt.slice(0, 10) : undefined;
    if (signal?.positionId) positionOf.set(row.id, signal.positionId);
    if (signal?.location) locationOf.set(row.id, signal.location);
    const image = (attrs.mimetype ?? '').startsWith('image/');
    return {
      id: row.id,
      path: row.path,
      name: basename(row.path),
      folderId: folderIdOf.get(row.id)!,
      folder: dirname(row.path),
      mimetype: attrs.mimetype ?? '',
      timeMs: precision === 'none' ? Number.NaN : Date.parse(attrs.takenAtUtc!),
      precision,
      ...(day && precision === 'instant' ? { day } : {}),
      ...(typeof attrs.takenAt === 'string' ? { takenAt: attrs.takenAt } : {}),
      ...(typeof attrs.takenAtSource === 'string' ? { takenAtSource: attrs.takenAtSource } : {}),
      ...(typeof attrs.width === 'number' ? { width: attrs.width } : {}),
      ...(typeof attrs.height === 'number' ? { height: attrs.height } : {}),
      ...(typeof attrs.devicePath === 'string' ? { device: attrs.devicePath } : {}),
      ...(typeof attrs.faceCount === 'number' ? { faceCount: attrs.faceCount } : {}),
      ...(signal?.point ? { lat: signal.point.lat, lng: signal.point.lng } : {}),
      ...(signal && signal.persons.length > 0 ? { persons: signal.persons } : {}),
      ...(signal?.localFolder ? { localFolder: signal.localFolder } : {}),
      ready: !image || attrs.facesAt !== undefined,
    };
  });
  const positions = await batched([...new Set(positionOf.values())], (page) => vfs.getNodesByIds<Geocode>(access, page));
  const geocodes = new Map([...positions].map(([id, node]) => [id, { city: node.attrs.city, country: node.attrs.country, poi: node.attrs.poi }]));
  return { items, folders, pending, idOf, geocodes, positionOf, locationOf };
};

/** What one scope's media add to another's: `into` gains `from`'s, each item once. */
export const mergeMedia = (into: ScopeMedia, from: ScopeMedia): void => {
  const known = new Set(into.items.map((item) => item.id));
  into.items.push(...from.items.filter((item) => !known.has(item.id)));
  into.pending += from.pending;
  for (const [key, value] of from.folders) into.folders.set(key, value);
  for (const [key, value] of from.idOf) into.idOf.set(key, value);
  for (const [key, value] of from.geocodes) into.geocodes.set(key, value);
  for (const [key, value] of from.positionOf) into.positionOf.set(key, value);
  for (const [key, value] of from.locationOf) into.locationOf.set(key, value);
};

const emptyMedia = (): ScopeMedia => ({ items: [], folders: new Map(), pending: 0, idOf: new Map(), geocodes: new Map(), positionOf: new Map(), locationOf: new Map() });

/** What planning reads from outside the category: who the household is, and each person's share of the library's faces. */
type LibraryInputs = { household: Set<string>; faceShare: Map<string, number> };

/** What the organizer reads once per user, whatever their categories. */
type OwnerContext = {
  user: string;
  owner: { uid: number; gid: number };
  /** The owner's own access: what may name their groups. */
  access: Access;
  locations: LocationPoint[];
  /** People by id, as naming reads them. */
  people: Map<string, CastMember>;
  /** Read once, by the first full build or analysis that needs them. */
  library?: Promise<LibraryInputs>;
};

/** The owner's person and its partners and children, by node id. */
const readHousehold = async (vfs: Vfs, access: Access, user: string): Promise<Set<string>> => {
  const link = await vfs.get(access, `${USERS_PATH}/${user}/person`, { follow: false }).catch(() => undefined);
  const person = link?.props.softlink;
  if (!person) return new Set();
  const ctx = makeCtx(vfs, access);
  const relatives = [...await getPartners(ctx, person).catch(() => []), ...await getChildren(ctx, person).catch(() => [])];
  const paths = [person, ...relatives.map((relative) => relative.path)];
  const nodes = await Promise.all(paths.map((path) => vfs.get(access, path).catch(() => undefined)));
  return new Set(nodes.flatMap((node) => node ? [node.id] : []));
};

/** Each person's share of the library's face regions: one aggregate over the `person` index. */
const readFaceShare = async (vfs: Vfs, access: Access): Promise<Map<string, number>> => {
  const buckets = await vfs.aggregate(access, { types: ['media-region'], where: [{ ref: 'personId', op: 'exists' }], group: [{ ref: 'personId' }] });
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return new Map(buckets.map((bucket) => [String(bucket.key[0]), total > 0 ? bucket.count / total : 0]));
};

/**
 * The owner's household and the library's face shares, read once per owner context. Planning no
 * items names no one, so for none they are not read, and are empty.
 */
const libraryOf = (vfs: Vfs, access: Access, owner: OwnerContext, items: readonly PlanItem[]): Promise<LibraryInputs> =>
  items.length === 0
    ? Promise.resolve({ household: new Set(), faceShare: new Map() })
    : owner.library ??= Promise.all([readHousehold(vfs, owner.access, owner.user), readFaceShare(vfs, access)]).then(([household, faceShare]) => ({ household, faceShare }));

/** The owner's context: who they are, and the locations they can open. */
export const readOwner = async (vfs: Vfs, access: Access, user: string, homePath: string): Promise<OwnerContext> => {
  const home = await vfs.get(access, homePath);
  const owner = { uid: home.props.uid, gid: home.props.gid };
  const ownerAccess = access.uid === owner.uid ? access : await accessOfUser(vfs, access, user);
  const locations = await readLocations(vfs, ownerAccess).catch(() => []);
  return { user, owner, access: ownerAccess, locations, people: new Map() };
};

/**
 * Read the people `ids` names not yet known to `ctx`, as the owner sees them. An unnamed person
 * (a face cluster recognition made, still called "Unknown …") has no name to give a group.
 */
const readPeople = async (vfs: Vfs, ctx: OwnerContext, ids: string[]): Promise<void> => {
  const missing = [...new Set(ids)].filter((id) => !ctx.people.has(id));
  const nodes = await batched(missing, (page) => vfs.getNodesByIds<PersonNodeAttrs>(ctx.access, page));
  for (const [id, node] of nodes) {
    if (node.type !== NODE_TYPE_PERSON || typeof node.attrs.name !== 'string' || isUnnamed(node.attrs)) continue;
    ctx.people.set(id, { name: node.attrs.name, ...(typeof node.attrs.born === 'string' ? { born: node.attrs.born } : {}) });
  }
};

/** A suggested group of a category's directory, as listed: its node without its links. */
type GroupEntry = {
  path: string;
  slug: string;
  id: string;
  attrs: { name?: string; origin?: string; autoAlbum?: AutoAlbumMeta };
  props: { uid: number; gid: number; mode: number };
};

/** A group with its member links and cover read. */
type ExistingGroup = GroupEntry & {
  links: { name: string; target: string }[];
  cover?: string;
  /** The member ids, by link order; undefined for a link to nothing. */
  memberIds: (string | undefined)[];
  /** The names of its member links to nothing: the file they named is gone. */
  gone: string[];
  pinned: boolean;
  claimed: boolean;
};

/** Every suggested group in `albumsPath`, without its links: one paged listing. */
const listGroups = async (vfs: Vfs, access: Access, albumsPath: string): Promise<GroupEntry[]> => {
  const entries: NodeChildEntry[] = [];
  let after: string | undefined;
  while (true) {
    const page = await vfs.children(access, albumsPath, { types: ['album'], page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
    entries.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1].name;
  }
  return entries.filter((entry) => !entry.name.startsWith('.') && (entry.node.attrs as { origin?: string }).origin === AUTO_ORIGIN).map((entry) => ({
    path: `${albumsPath}/${entry.name}`,
    slug: entry.name,
    id: entry.node.id,
    attrs: entry.node.attrs as GroupEntry['attrs'],
    props: { uid: entry.node.props.uid, gid: entry.node.props.gid, mode: entry.node.props.mode },
  }));
};

/** `groups` with their links read: one batched listing per 500 groups, the targets `idOf` does not know resolved in one more. */
const readLinks = async (vfs: Vfs, access: Access, groups: GroupEntry[], idOf: ReadonlyMap<string, string>): Promise<ExistingGroup[]> => {
  const out: ExistingGroup[] = [];
  for (let i = 0; i < groups.length; i += LIST_CHUNK) {
    const chunk = groups.slice(i, i + LIST_CHUNK);
    const listings = await vfs.childrenMany(access, chunk.map((group) => group.path), { follow: false });
    chunk.forEach((group, j) => {
      const listing = listings[j];
      const children = listing.status === 'fulfilled' ? listing.value : [];
      const links = children.filter((child) => child.name !== COVER_LINK_NAME && typeof child.node.props.softlink === 'string')
        .map((child) => ({ name: child.name, target: child.node.props.softlink! }));
      out.push({
        ...group,
        links,
        cover: children.find((child) => child.name === COVER_LINK_NAME)?.node.props.softlink,
        memberIds: [],
        gone: [],
        pinned: false,
        claimed: false,
      });
    });
  }
  const unknown = [...new Set(out.flatMap((group) => group.links.map((link) => link.target)).filter((target) => !idOf.has(target)))];
  const resolved = unknown.length > 0 ? await idsAt(vfs, access, unknown) : new Map<string, string>();
  for (const group of out) {
    group.memberIds = group.links.map((link) => idOf.get(link.target) ?? resolved.get(link.target));
    group.gone = group.links.filter((_, i) => group.memberIds[i] === undefined).map((link) => link.name);
    // A group with no members left holds nothing a person chose: it goes, pinned or not.
    group.pinned = group.gone.length < group.links.length && isUserEdited(group.attrs, group.memberIds);
  }
  return out;
};

/** Every suggested group in `albumsPath`, with its links. */
const readGroups = async (vfs: Vfs, access: Access, albumsPath: string, idOf: ReadonlyMap<string, string>): Promise<ExistingGroup[]> =>
  await readLinks(vfs, access, await listGroups(vfs, access, albumsPath), idOf);

// ── the checkpoint and the request ──────────────────────────────────────────

const encoder = new TextEncoder();

/** The checkpoint's body, or none before the first run (or for one of an older shape, or that cannot be read). */
const readCheckpoint = async (vfs: Vfs, access: Access, albumsPath: string): Promise<Checkpoint | undefined> => {
  try {
    const handle = await vfs.open(access, `${albumsPath}/${ORGANIZER_CHECKPOINT}`, { mode: 'r' });
    try {
      const body = JSON.parse(await new Response(handle.readable).text()) as Checkpoint;
      return body.version === 2 ? body : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

/** Write the checkpoint: its summary as attrs, its body as JSON, owned by the home's owner, 0600. */
const writeCheckpoint = async (vfs: Vfs, access: Access, albumsPath: string, owner: { uid: number; gid: number }, summary: OrganizerSummary, body?: Checkpoint) => {
  const path = `${albumsPath}/${ORGANIZER_CHECKPOINT}`;
  if (!(await vfs.exists(access, path, { follow: false }))) {
    await vfs.create(access, 'file', albumsPath, ORGANIZER_CHECKPOINT, {
      props: { uid: owner.uid, gid: owner.gid, mode: CHECKPOINT_MODE, tier: 'db' },
      attrs: { [SUMMARY_ATTR]: summary, mimetype: 'application/json', size: 0 },
    });
  }
  if (body) {
    const bytes = encoder.encode(JSON.stringify(body));
    const handle = await vfs.open(access, path, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
    await vfs.update(access, path, { attrs: { [SUMMARY_ATTR]: summary, size: bytes.length } });
  } else {
    await vfs.update(access, path, { attrs: { [SUMMARY_ATTR]: summary } });
  }
};

/** A category's organizer summary from its checkpoint's attrs; null before its first run. */
export const readOrganizerSummary = async (vfs: Vfs, access: Access, albumsPath: string): Promise<OrganizerSummary | null> => {
  const node = await vfs.get<{ [SUMMARY_ATTR]?: OrganizerSummary }>(access, `${albumsPath}/${ORGANIZER_CHECKPOINT}`, { follow: false }).catch(() => undefined);
  return node?.attrs[SUMMARY_ATTR] ?? null;
};

/** When a run of the category was last asked for (`.request`), if ever. */
const readRequest = async (vfs: Vfs, access: Access, albumsPath: string): Promise<string | undefined> => {
  const node = await vfs.get<{ [REQUEST_ATTR]?: { at?: string } }>(access, `${albumsPath}/${ORGANIZER_REQUEST}`, { follow: false }).catch(() => undefined);
  return node?.attrs[REQUEST_ATTR]?.at;
};

/**
 * Ask for a run of the category: write its request (`albums/<category>/.request`), a db-tier node of
 * the home's owner, 0600, holding only when it was asked. The bridge turns the write into the fact
 * that starts the run, so whoever may write in the category's directory of groups may ask.
 */
const writeRequest = async (vfs: Vfs, access: Access, albumsPath: string, owner: { uid: number; gid: number }, at: string): Promise<void> => {
  const path = `${albumsPath}/${ORGANIZER_REQUEST}`;
  if (await vfs.exists(access, path, { follow: false })) {
    await vfs.update(access, path, { attrs: { [REQUEST_ATTR]: { at } } });
    return;
  }
  await vfs.create(access, 'file', albumsPath, ORGANIZER_REQUEST, {
    props: { uid: owner.uid, gid: owner.gid, mode: CHECKPOINT_MODE, tier: 'db' },
    attrs: { [REQUEST_ATTR]: { at }, size: 0 },
  });
};

// ── naming ──────────────────────────────────────────────────────────────────

/** The most common value and its share of `votes`. */
const majority = (votes: string[]): { value: string; share: number } | undefined => {
  if (votes.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  let best: { value: string; share: number } | undefined;
  for (const [value, n] of counts) if (!best || n / votes.length > best.share) best = { value, share: n / votes.length };
  return best;
};

/** The mean point of the items with GPS. */
const centroidOf = (items: PlanItem[]): Geo | undefined => {
  const located = items.filter((item) => item.lat !== undefined && item.lng !== undefined);
  if (located.length === 0) return undefined;
  return { lat: located.reduce((sum, item) => sum + item.lat!, 0) / located.length, lng: located.reduce((sum, item) => sum + item.lng!, 0) / located.length };
};

/** What naming and the place rule know of a scope. */
type Namer = {
  /** The location a run of items was at, as the owner can open it: most of their links, else the nearest known within 500 m. */
  locationFor: (items: PlanItem[]) => LocationPoint | { path: string; name: string } | undefined;
  /** The point of interest, or the city and the country, most located items were at. */
  geocodeFor: (items: PlanItem[]) => { poi?: string; city?: string; country?: string };
  atPlace: (items: PlanItem[]) => boolean;
  home: (day: string) => AutoAlbumHome | undefined;
};

/**
 * The locations the items of `media` link to, as the owner can open them, with their names: one
 * read per distinct location, those with a point known already.
 */
const readLinkedLocations = async (vfs: Vfs, media: ScopeMedia, owner: OwnerContext): Promise<Map<string, LocationPoint | { path: string; name: string }>> => {
  const known = new Map<string, LocationPoint | { path: string; name: string }>(owner.locations.map((location) => [location.path, location]));
  const linked = [...new Set(media.locationOf.values())].filter((path) => !known.has(path));
  await Promise.all(linked.map(async (path) => {
    const node = await vfs.get<{ name?: unknown; displayName?: unknown }>(owner.access, path).catch(() => undefined);
    if (!node) return;
    const name = typeof node.attrs.name === 'string' && node.attrs.name
      ? node.attrs.name
      : typeof node.attrs.displayName === 'string' && node.attrs.displayName
      ? node.attrs.displayName
      : basename(path);
    known.set(path, { path, name });
  }));
  return known;
};

const namer = (media: ScopeMedia, owner: OwnerContext, homes: Map<string, AutoAlbumHome>, byPath: Map<string, LocationPoint | { path: string; name: string }>): Namer => {
  const home = (day: string) => homes.get(day.slice(0, 4));
  const locationFor: Namer['locationFor'] = (items) => {
    const linked = majority(items.flatMap((item) => media.locationOf.get(item.id) ?? []));
    if (linked && linked.share >= MAJORITY) {
      const known = byPath.get(linked.value);
      if (known) return known;
    }
    const at = centroidOf(items);
    if (!at) return undefined;
    let best: { location: LocationPoint; d: number } | undefined;
    for (const location of owner.locations) {
      const d = haversineMeters(at.lat, at.lng, location.lat, location.lng);
      if (d <= LOCATION_RADIUS_M && (!best || d < best.d)) best = { location, d };
    }
    return best?.location;
  };
  const geocodeFor: Namer['geocodeFor'] = (items) => {
    const codes = items.flatMap((item) => {
      const position = media.positionOf.get(item.id);
      const code = position ? media.geocodes.get(position) : undefined;
      return code ? [code] : [];
    });
    const pick = (field: keyof Geocode) => {
      const values = codes.flatMap((code) => code[field] ? [code[field]!] : []);
      const vote = majority(values);
      return vote && vote.share * values.length >= MAJORITY * codes.length ? vote.value : undefined;
    };
    return { poi: pick('poi'), city: pick('city'), country: pick('country') };
  };
  const atPlace: Namer['atPlace'] = (items) => {
    const location = locationFor(items);
    const where = home(dayOf(items[0]));
    if (location) {
      if (!where) return true;
      if (where.location === location.path) return false;
      return !('lat' in location) || haversineMeters(location.lat, location.lng, where.lat, where.lng) >= PLACE_FROM_HOME_M;
    }
    return geocodeFor(items).poi !== undefined;
  };
  return { locationFor, geocodeFor, atPlace, home };
};

/** Whether someone is a guest: outside the household, and in at most a small share of the library's faces. */
const guestOf = (library: LibraryInputs) => (id: string): boolean => !library.household.has(id) && (library.faceShare.get(id) ?? 0) <= GUEST_FACE_SHARE;

/** The name the organizer gives a planned group, and the location it names it after. */
const nameOf = (group: PlannedGroup, owner: OwnerContext, library: LibraryInputs, names: Namer): { name: string; location?: string } => {
  if (group.lane) return { name: laneName(group.lane) };
  const when = formatDates(group.items.flatMap((item) => item.takenAt ?? []));
  if (group.kind === 'folder' && group.run) return { name: groupName({ what: group.run.label, when: group.run.years }) || when || 'Scans' };
  const found = names.locationFor(group.items);
  // Home is where most days happen: naming it says nothing a date does not.
  const located = found && names.home(dayOf(group.items[0]))?.location === found.path ? undefined : found;
  const away = group.cluster?.away === true;
  const code = names.geocodeFor(group.items);
  const where = located?.name ?? code.poi ?? (away ? code.city ?? code.country : undefined);
  let what = group.seed?.label;
  if (!what && group.items.some((item) => item.precision === 'instant')) {
    const days = [...new Set(group.items.filter((item) => item.precision === 'instant').map(dayOf))];
    const cast = [...new Set(group.items.flatMap((item) => item.persons ?? []))];
    what = occasionOf(days, cast.flatMap((id) => owner.people.get(id) ?? []));
    if (!what && !away) {
      const isGuest = guestOf(library);
      const guests = cast.filter((id) => isGuest(id) && owner.people.has(id))
        .filter((id) => group.items.filter((item) => item.persons?.includes(id)).length >= GUESTS_SHARE * group.items.length)
        .sort((a, b) => (library.faceShare.get(a) ?? 0) - (library.faceShare.get(b) ?? 0));
      what = withGuests(guests.map((id) => owner.people.get(id)!.name));
    }
    if (!what && !where) what = momentOf(group.items.filter((item) => item.precision === 'instant').flatMap((item) => item.takenAt ?? []));
  }
  return { name: groupName({ what, where, when }) || basename(group.items[0].folder), ...(located ? { location: located.path } : {}) };
};

// ── groups as written ───────────────────────────────────────────────────────

/** The cover a group shows: its first picture with a face, else its earliest picture, else its first member. */
const coverOf = (group: PlannedGroup): { path: string; rule: 'face' | 'earliest' } => {
  const ordered = group.items.every((item) => item.precision !== 'none') ? group.items.toSorted(compareItems) : group.items;
  const images = ordered.filter((item) => item.mimetype.startsWith('image/'));
  const face = images.find((item) => (item.faceCount ?? 0) >= 1);
  return face ? { path: face.path, rule: 'face' } : { path: (images[0] ?? ordered[0]).path, rule: 'earliest' };
};

/** The meta a planned group is written with, but for `generatedAt`. */
const metaOf = (group: PlannedGroup, name: string, location: string | undefined, cover: 'face' | 'earliest'): Omit<AutoAlbumMeta, 'generatedAt'> => {
  const dated = group.items.filter((item) => item.precision !== 'none').toSorted(compareItems);
  const images = group.items.filter((item) => item.mimetype.startsWith('image/'));
  const waiting = images.filter((item) => item.ready === false).length;
  const cluster = group.cluster;
  const meta: Omit<AutoAlbumMeta, 'generatedAt'> = {
    kind: group.kind,
    ...(group.key ? { key: group.key } : {}),
    ...(dated.length > 0 ? { timeStart: new Date(dated[0].timeMs).toISOString(), timeEnd: new Date(dated[dated.length - 1].timeMs).toISOString() } : {}),
    ...(group.precision ? { precision: group.precision } : {}),
    ...(group.folderId && !group.folderId.startsWith('dir:') ? { folderId: group.folderId } : {}),
    ...(location ? { locationPath: location } : {}),
    memberKey: memberKeyOf(group.items.map((item) => item.id)),
    memberCount: group.items.length,
    shots: group.shots,
    ...(cluster ? { scores: cluster.scores } : {}),
    generatedName: name,
    generatedBy: GENERATED_BY,
    provisional: images.length > 0 && waiting > PROVISIONAL_SHARE * images.length,
    ...(dated.length > 0 ? { days: new Set(dated.map(dayOf)).size } : {}),
    ...(cluster?.away !== undefined ? { away: cluster.away } : {}),
    ...(cluster?.parts && cluster.parts.length > 1
      ? {
        parts: cluster.parts.map((part) => ({
          timeStart: part.timeStart,
          timeEnd: part.timeEnd,
          memberCount: part.items.length,
          ...(part.centroid ? { centroid: part.centroid } : {}),
        })),
      }
      : {}),
    ...(group.lane && dated.length > 0 ? { dayCounts: dayCountsOf(dated) } : {}),
    ...(group.significance ? { significance: group.significance } : {}),
    ...(group.seed ? { seed: group.seed } : {}),
    cover,
  };
  return meta;
};

const dayCountsOf = (items: PlanItem[]): [string, number][] => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(dayOf(item), (counts.get(dayOf(item)) ?? 0) + 1);
  return [...counts];
};

/** Two metas alike in everything the organizer writes, `generatedAt` and what a person set aside. */
const sameMeta = (a: AutoAlbumMeta | undefined, b: Omit<AutoAlbumMeta, 'generatedAt'>): boolean => {
  if (!a) return false;
  const { generatedAt: _at, nameLocked: _locked, pinned: _pinned, ...rest } = a;
  return JSON.stringify(sortKeys(rest)) === JSON.stringify(sortKeys(b));
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]),
  );
};

/** A path segment from `text`: slashes and runs of spaces as dashes, no leading dot, at most 80 bytes. */
const segment = (text: string): string => {
  let out = text.normalize('NFC').replace(/[/\\]+/g, '-').replace(/\s+/g, '-').replace(/^\.+/, '').replace(/^-+|-+$/g, '');
  while (encoder.encode(out).length > 80) out = out.slice(0, -1);
  return out || 'group';
};

/** The slug a new group is created under. */
const slugBase = (group: PlannedGroup, folders: ReadonlyMap<string, PlanFolder>): string => {
  const folderName = (id?: string) => (id && folders.get(id)?.name) || 'folder';
  const key = group.key ?? '';
  const chunk = key.match(/#(\d+)$/)?.[1];
  const suffix = chunk ? `-${chunk}` : '';
  const [, period] = key.split(':');
  switch (group.kind) {
    case 'loose':
      if (key.startsWith('period:')) return segment(`${period}-period-${folderName(group.folderId)}${suffix}`);
      if (key.startsWith('none:')) return segment(`${key.split(':')[2]?.replace(/#.*/, '')}-${folderName(group.folderId)}${suffix}`);
      return segment(`${period.replace(/#.*/, '')}-loose${suffix}`);
    case 'clutter':
      return segment(`${period.replace(/#.*/, '')}-clutter${suffix}`);
    case 'undated':
      return segment(`undated-${folderName(group.folderId)}${suffix}`);
    case 'seed':
      return segment(`seed-${group.seed?.label ?? folderName(group.folderId)}`);
    case 'folder':
      return segment(`folder-${group.run?.label ?? folderName(group.folderId)}`);
    default:
      return dayOf(group.items.toSorted(compareItems)[0]);
  }
};

/** `base`, or `base-2`, `base-3`, … — the first not in `used`, which it joins. */
const freeSlug = (base: string, used: Set<string>): string => {
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
};

// ── pairing ─────────────────────────────────────────────────────────────────

/** Each planned group's existing group, or undefined for a new one. */
const pair = (planned: PlannedGroup[], existing: ExistingGroup[]): (ExistingGroup | undefined)[] => {
  const free = existing.filter((group) => !group.pinned);
  const byKey = new Map<string, ExistingGroup>();
  for (const group of free) {
    const key = group.attrs.autoAlbum?.key;
    if (key && !byKey.has(key)) byKey.set(key, group);
  }
  const out: (ExistingGroup | undefined)[] = planned.map(() => undefined);
  planned.forEach((group, i) => {
    const found = group.key ? byKey.get(group.key) : undefined;
    if (found && !found.claimed) {
      found.claimed = true;
      out[i] = found;
    }
  });

  // Events, trips and runs by their members: the same key first, then the most in common.
  const holder = new Map<string, ExistingGroup>();
  for (const group of free) {
    if (group.claimed || group.attrs.autoAlbum?.key) continue;
    for (const id of group.memberIds) if (id) holder.set(id, group);
  }
  const candidates: { i: number; group: ExistingGroup; score: number }[] = [];
  planned.forEach((group, i) => {
    if (group.key) return;
    const key = memberKeyOf(group.items.map((item) => item.id));
    const shared = new Map<ExistingGroup, number>();
    for (const item of group.items) {
      const held = holder.get(item.id);
      if (held) shared.set(held, (shared.get(held) ?? 0) + 1);
    }
    for (const [held, count] of shared) {
      const exact = held.attrs.autoAlbum?.memberKey === key && held.memberIds.length === group.items.length;
      const jaccard = count / (group.items.length + held.memberIds.filter(Boolean).length - count);
      if (exact || jaccard >= 0.5) candidates.push({ i, group: held, score: exact ? 2 : jaccard });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.i - b.i);
  for (const { i, group } of candidates) {
    if (out[i] || group.claimed) continue;
    group.claimed = true;
    out[i] = group;
  }
  return out;
};

// ── planning and writing ────────────────────────────────────────────────────

type OrganizeOptions = { dryRun?: boolean; members?: boolean; full?: boolean };

const reportOf = (
  action: ClusterGroupReport['action'],
  kind: GroupKind,
  name: string,
  members: string[],
  extra: Partial<ClusterGroupReport>,
  withPaths: boolean,
): ClusterGroupReport => ({ action, kind, name, members: members.length, ...extra, ...(withPaths ? { memberPaths: members } : {}) });

/** The parameters a plan depends on beside the items: when they change, everything is planned again. */
const paramsKeyOf = (settings: StagingCategorySettings): string => `v2:${settings.group.strategy}:${settings.group.significance}`;

/** The local years of the items with an instant, and their GPS points by year. */
const pointsByYearOf = (items: PlanItem[]): { years: string[]; points: Map<string, Geo[]> } => {
  const dated = items.filter((item) => item.precision === 'instant');
  const points = new Map<string, Geo[]>();
  for (const item of dated) {
    if (item.lat === undefined || item.lng === undefined) continue;
    const year = dayOf(item).slice(0, 4);
    const list = points.get(year);
    if (list) list.push({ lat: item.lat, lng: item.lng });
    else points.set(year, [{ lat: item.lat, lng: item.lng }]);
  }
  return { years: dated.map((item) => dayOf(item).slice(0, 4)), points };
};

/** The planning context of a scope, beside what a plan of part of a category is told (`seedFolders`, `dayShots`, `lanes`). */
type ScopeOptions = Pick<PlanContext, 'seedFolders' | 'dayShots' | 'lanes'> & {
  strategy: StagingCategorySettings['group'];
  edits: StagingEdit[];
  items?: PlanItem[];
  granularity?: Record<string, 'year' | 'month'>;
  homes: Map<string, AutoAlbumHome>;
  library: LibraryInputs;
};

/**
 * Plan the media of one scope: the people and places a plan needs read, and the plan made. Used by
 * the organizer and by the read-only analysis.
 */
const planWith = async (vfs: Vfs, media: ScopeMedia, owner: OwnerContext, options: ScopeOptions): Promise<{ plan: Plan; names: Namer }> => {
  const items = options.items ?? media.items;
  await readPeople(vfs, owner, items.flatMap((item) => item.persons ?? []));
  const names = namer(media, owner, options.homes, await readLinkedLocations(vfs, media, owner));
  const ctx: PlanContext = {
    strategy: options.strategy.strategy,
    significance: options.strategy.significance,
    edits: options.edits,
    folders: media.folders,
    home: (day) => names.home(day),
    isGuest: guestOf(options.library),
    cast: (id) => owner.people.get(id),
    atPlace: names.atPlace,
    granularity: options.granularity ?? {},
    ...(options.seedFolders ? { seedFolders: options.seedFolders } : {}),
    ...(options.dayShots ? { dayShots: options.dayShots } : {}),
    ...(options.lanes ? { lanes: options.lanes } : {}),
  };
  return { plan: planCategory(items, ctx), names };
};

/**
 * Plan the media of one scope as a full build plans a category: its homes, household and guests
 * read, and the plan made. The read-only analysis plans with it too.
 */
export const planScope = async (
  vfs: Vfs,
  media: ScopeMedia,
  owner: OwnerContext,
  options: { strategy: StagingCategorySettings['group']; edits: StagingEdit[]; items?: PlanItem[]; granularity?: Record<string, 'year' | 'month'>; flagHome?: Geo },
): Promise<{ plan: Plan; homes: Map<string, AutoAlbumHome>; names: Namer; library: LibraryInputs }> => {
  const items = options.items ?? media.items;
  const { years, points } = pointsByYearOf(items);
  const homes = await homesByYear(vfs, owner.access, { user: owner.user, years, pointsByYear: points, flag: options.flagHome });
  const library = await libraryOf(vfs, owner.access, owner, items);
  const { plan, names } = await planWith(vfs, media, owner, { ...options, homes, library });
  return { plan, homes, names, library };
};

/** A plan's groups as the analysis reports them: each proposed, none written. */
export const proposedGroups = (plan: Plan, owner: OwnerContext, library: LibraryInputs, names: Namer, withPaths: boolean): ClusterGroupReport[] =>
  plan.groups.map((group) => {
    const { name } = nameOf(group, owner, library, names);
    const meta = metaOf(group, name, undefined, coverOf(group).rule);
    return reportOf('proposed', group.kind, name, group.items.map((item) => item.path), describe(meta, group), withPaths);
  });

/** What a report says of a group beside its members. */
const describe = (meta: Omit<AutoAlbumMeta, 'generatedAt'>, group?: PlannedGroup): Partial<ClusterGroupReport> => ({
  ...(meta.shots !== undefined ? { shots: meta.shots } : {}),
  ...(meta.timeStart ? { timeStart: meta.timeStart, timeEnd: meta.timeEnd } : {}),
  ...(meta.provisional !== undefined ? { provisional: meta.provisional } : {}),
  ...(meta.days !== undefined ? { days: meta.days } : {}),
  ...(group?.cluster?.parts ? { parts: group.cluster.parts.length } : {}),
  ...(meta.significance ? { significance: meta.significance.reason } : {}),
});

/** A run's result before anything is counted. */
const emptyResult = (user: string, category: string, mode: OrganizeResult['mode'], dryRun: boolean): OrganizeResult => ({
  user,
  category,
  mode,
  dryRun,
  records: 0,
  windows: 0,
  items: 0,
  pending: 0,
  covered: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  pinned: 0,
  byKind: {},
  bareDates: 0,
  watermark: null,
  matched: 0,
  durationMs: 0,
  groups: [],
});

/** What a run writes of a plan, and to whom. */
type WriteContext = {
  vfs: Vfs;
  access: Access;
  albumsPath: string;
  owner: OwnerContext;
  library: LibraryInputs;
  names: Namer;
  folders: ReadonlyMap<string, PlanFolder>;
  /** Every slug in the category's directory of groups, which a new one may not take. */
  used: Set<string>;
  dryRun: boolean;
  members: boolean;
};

/** What `writePlan` did, beside what it added to the result. */
type Written = { kinds: GroupKind[]; created: string[] };

/**
 * Pair `planned` with `existing` (the groups the plan may take the place of, and the pinned groups
 * to keep up), and write what differs: links to nothing out of pinned groups (and a pinned group
 * left with no member, whole), a hand-edited group marked pinned, each planned group made or
 * rewritten, and each free group of `existing` no plan claimed deleted. Counts into `result`; a dry
 * run writes nothing.
 */
const writePlan = async (ctx: WriteContext, planned: PlannedGroup[], existing: ExistingGroup[], result: OrganizeResult): Promise<Written> => {
  const { vfs, access, albumsPath } = ctx;
  const paired = pair(planned, existing);
  const now = new Date().toISOString();
  const removing = existing.filter((group) => !group.pinned && !group.claimed);
  const unlink: string[] = [];
  const updates: { ref: string; attrs: Record<string, unknown> }[] = [];
  const linkWrites: { path: string; specs: ReturnType<typeof memberLinkSpecs> }[] = [];
  const creates: ReturnType<typeof groupSpec>[] = [];
  const kinds: GroupKind[] = [];

  for (const group of existing.filter((each) => each.pinned)) {
    result.pinned++;
    kinds.push(group.attrs.autoAlbum?.kind ?? 'event');
    result.groups.push(
      reportOf('pinned', group.attrs.autoAlbum?.kind ?? 'event', group.attrs.name ?? group.slug, group.links.map((link) => link.target), { path: group.path }, ctx.members),
    );
    // What it held that is gone (deleted, not moved) leaves it; the rest stays a person's.
    unlink.push(...group.gone.map((name) => `${group.path}/${name}`));
    if (group.attrs.autoAlbum && !group.attrs.autoAlbum.pinned) {
      updates.push({ ref: group.path, attrs: { autoAlbum: { ...group.attrs.autoAlbum, pinned: true } } });
    }
  }

  planned.forEach((group, i) => {
    const target = paired[i];
    const generated = nameOf(group, ctx.owner, ctx.library, ctx.names);
    const cover = coverOf(group);
    const meta = metaOf(group, generated.name, generated.location, cover.rule);
    const locked = target !== undefined && isNameLocked(target.attrs);
    const name = locked ? target!.attrs.name! : generated.name;
    const members = group.items.map((item) => item.path);
    kinds.push(group.kind);
    if (!locked && name === formatDates(group.items.flatMap((item) => item.takenAt ?? []))) result.bareDates++;

    if (!target) {
      const slug = freeSlug(slugBase(group, ctx.folders), ctx.used);
      result.created++;
      result.groups.push(reportOf('create', group.kind, name, members, { path: `${albumsPath}/${slug}`, ...describe(meta, group) }, ctx.members));
      creates.push(groupSpec(slug, { name, autoAlbum: { ...meta, generatedAt: now } }, members, ctx.owner.owner, cover.path));
      return;
    }

    const planned = new Set(members);
    const stale = target.links.filter((link) => !planned.has(link.target));
    const have = new Set(target.links.map((link) => link.target));
    const adding = members.filter((path) => !have.has(path));
    const coverChanges = target.cover !== cover.path;
    const metaChanges = !sameMeta(target.attrs.autoAlbum, meta) || (!locked && target.attrs.name !== name);
    if (stale.length === 0 && adding.length === 0 && !coverChanges && !metaChanges) {
      result.unchanged++;
      result.groups.push(reportOf('unchanged', group.kind, name, members, { path: target.path, ...describe(meta, group) }, ctx.members));
      return;
    }
    result.updated++;
    result.groups.push(reportOf('update', group.kind, name, members, { path: target.path, ...describe(meta, group) }, ctx.members));
    unlink.push(...stale.map((link) => `${target.path}/${link.name}`), ...(coverChanges && target.cover !== undefined ? [`${target.path}/${COVER_LINK_NAME}`] : []));
    const keptMeta = target.attrs.autoAlbum;
    updates.push({
      ref: target.path,
      attrs: {
        ...(locked ? {} : { name }),
        autoAlbum: { ...meta, generatedAt: now, ...(keptMeta?.nameLocked ? { nameLocked: true } : {}) },
      },
    });
    const usedNames = new Set([COVER_LINK_NAME, ...target.links.filter((link) => planned.has(link.target)).map((link) => link.name)]);
    const specs = memberLinkSpecs(adding, usedNames, ctx.owner.owner);
    if (coverChanges) {
      specs.push({ type: 'softlink', name: COVER_LINK_NAME, props: { uid: ctx.owner.owner.uid, gid: ctx.owner.owner.gid, mode: 0o777, softlink: cover.path } });
    }
    if (specs.length > 0) linkWrites.push({ path: target.path, specs });
  });

  for (const group of removing) {
    result.removed++;
    result.groups.push(
      reportOf('removed', group.attrs.autoAlbum?.kind ?? 'event', group.attrs.name ?? group.slug, group.links.map((link) => link.target), { path: group.path }, ctx.members),
    );
  }

  const created: string[] = [];
  if (!ctx.dryRun) {
    // Links before the groups that held them, then attrs, links and groups.
    const goneLinks = removing.flatMap((
      group,
    ) => [...group.links.map((link) => `${group.path}/${link.name}`), ...(group.cover !== undefined ? [`${group.path}/${COVER_LINK_NAME}`] : [])]);
    await settle(vfs.unlinkMany(access, [...goneLinks, ...unlink]));
    // Whole: a pipeline may have given a group children of its own (its `metadata/`).
    for (const group of removing) await vfs.unlink(access, group.path, albumsPath, { recursive: true, follow: false });
    if (updates.length > 0) await settle(vfs.updateEach(access, updates));
    for (const write of linkWrites) await vfs.createTree(access, write.path, write.specs);
    if (creates.length > 0) created.push(...(await vfs.createTree(access, albumsPath, creates)).map((node) => node.id));
  }
  return { kinds, created };
};

/** Throw the first refusal among settled writes. */
const settle = async <T>(outcomes: Promise<PromiseSettledResult<T>[]>): Promise<void> => {
  const refused = (await outcomes).find((outcome) => outcome.status === 'rejected');
  if (refused) throw (refused as PromiseRejectedResult).reason;
};

/** The groups of a category's directory by kind, how many there are and how many members they hold (a pinned group's as `pinned` has them). */
const countGroups = (
  groups: GroupEntry[],
  pinned: ReadonlyMap<string, ReadonlySet<string>>,
): { groups: number; members: number; byKind: Partial<Record<GroupKind, number>> } => {
  const byKind: Partial<Record<GroupKind, number>> = {};
  let members = 0;
  for (const group of groups) {
    const kind = group.attrs.autoAlbum?.kind ?? 'event';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    members += pinned.get(group.id)?.size ?? group.attrs.autoAlbum?.memberCount ?? 0;
  }
  return { groups: groups.length, members, byKind };
};

/** The category's staged media still waiting to be indexed, in one aggregate. */
const countPending = async (vfs: Vfs, access: Access, root: string): Promise<number> => {
  const buckets = await vfs.aggregate(access, {
    within: root,
    types: ['file'],
    where: [{ ref: 'sourceId', op: 'missing' }, { ref: 'indexedAt', op: 'missing' }, { ref: 'size', op: 'ne', value: 0 }, {
      ref: { path: ['duplicate', 'deferred'] },
      op: 'missing',
    }],
    group: [{ ref: 'mimetype', prefixLength: 6 }],
  });
  return buckets.filter((bucket) => ['image/', 'video/', 'audio/'].includes(String(bucket.key[0]))).reduce((sum, bucket) => sum + bucket.count, 0);
};

// ── the audit trail ─────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The smallest record id a write made at `ms` can have: its ULID's time part, then zeros. */
const idFloor = (ms: number): string => {
  let out = '';
  let time = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out + '0'.repeat(16);
};

/** Where the trail is read from next: past every record at least `LAG_MS` older than `runStart`, never back. */
const nextWatermark = (previous: string | undefined, read: AuditRecord[], runStart: number): string => {
  let mark = idFloor(runStart - LAG_MS);
  if (previous && previous > mark) mark = previous;
  for (const record of read) if (record.timestamp <= runStart - LAG_MS && record.id > mark) mark = record.id;
  return mark;
};

/**
 * The records within `pathPrefix` after `after`, oldest first, but those in `skip` and those `keep`
 * refuses; a page at a time. Stops early, answering `over: true`, once `budget` says the run will
 * plan the category whole anyway.
 */
const readTrail = async (
  vfs: Vfs,
  access: Access,
  query: { pathPrefix: string; after: string; nodeTypes: string[] },
  skip: ReadonlySet<string>,
  keep: (record: AuditRecord) => boolean,
  budget: (records: AuditRecord[]) => boolean = () => true,
): Promise<{ records: AuditRecord[]; over: boolean }> => {
  const records: AuditRecord[] = [];
  let after = query.after;
  while (true) {
    const page = await vfs.audit(access, { ...query, after, limit: TRAIL_PAGE });
    for (const record of page) if (!skip.has(record.id) && keep(record)) records.push(compact(record));
    if (!budget(records)) return { records, over: true };
    if (page.length < TRAIL_PAGE) return { records, over: false };
    after = page[page.length - 1].id;
  }
};

/** A record as a run keeps it: without the values it does not read, so a long trail costs little memory. */
const compact = (record: AuditRecord): AuditRecord => {
  const { attrs, props: _props, ...rest } = record;
  const kept = attrs && Object.fromEntries(Object.entries(attrs).filter(([name]) => name === 'takenAtUtc' || name === 'title'));
  return kept && Object.keys(kept).length > 0 ? { ...rest, attrs: kept } : rest;
};

/** The staged file a record of one of its children is about (`<file>/position`, `/location`, `/sidecar`, `/regions/<r>`, `/people/<p>`). */
const ownerOf = (path: string): string | undefined => {
  const parts = path.split('/');
  const [parent, last] = [parts[parts.length - 2], parts[parts.length - 1]];
  if (last === POSITION_CHILD || last === LOCATION_LINK_NAME || last === SIDECAR_CHILD) return parts.slice(0, -1).join('/');
  if (parent === REGIONS_DIR || parent === PEOPLE_DIR) return parts.slice(0, -2).join('/');
  return undefined;
};

/** Whether `path` is `root` or lies below it. */
const within = (path: string | undefined, root: string): path is string => path !== undefined && (path === root || path.startsWith(`${root}/`));

/** A write to a category's groups that may change what they hold or whether a person keeps one: a group's own, or a member link's. */
const groupWrite = (albumsPath: string) => (record: AuditRecord): boolean => {
  const rest = (within(record.path, albumsPath) ? record.path : record.fromPath ?? '').slice(albumsPath.length + 1).split('/');
  if (rest[0] === undefined || rest[0] === '' || rest[0].startsWith('.')) return false;
  if (rest.length === 1) return record.nodeType === 'album' && (record.op !== 'update' || record.attrs?.autoAlbum !== undefined || record.props !== undefined);
  return rest.length === 2 && record.nodeType === 'softlink' && rest[1] !== COVER_LINK_NAME;
};

// ── the full build ──────────────────────────────────────────────────────────

/** Who is running, on what, and how. */
type Run = {
  cmd: Command;
  vfs: Vfs;
  access: Access;
  owner: OwnerContext;
  category: CategoryEntry;
  albumsPath: string;
  paramsKey: string;
  options: OrganizeOptions;
  started: number;
};

/** The records of the category's trail a full build need not apply again: those after `watermark` it will see, the newest `RECENT_MAX`. */
const trailSince = async (run: Run, watermark: string): Promise<string[]> => {
  if (!isAdmin(run.access)) return [];
  const ids: string[] = [];
  let after = watermark;
  while (true) {
    const page = await run.vfs.audit(run.access, { pathPrefix: run.category.path, after, nodeTypes: TRAIL_TYPES, limit: TRAIL_PAGE });
    ids.push(...page.map((record) => record.id));
    if (ids.length > RECENT_MAX) ids.splice(0, ids.length - RECENT_MAX);
    if (page.length < TRAIL_PAGE) return ids;
    after = page[page.length - 1].id;
  }
};

/** One full build of the category (see the file's comment). */
const fullBuild = async (run: Run, checkpoint: Checkpoint | undefined, why: OrganizeFullReason): Promise<OrganizeResult> => {
  const { vfs, access, owner, category, albumsPath, options } = run;
  const dryRun = options.dryRun === true;
  const result = emptyResult(owner.user, category.name, 'full', dryRun);
  result.why = why;
  const watermark = nextWatermark(checkpoint?.watermark, [], run.started);
  const recent = dryRun ? [] : await trailSince(run, watermark);

  const media = await readMedia(vfs, access, await readScopeFiles(vfs, access, category.path), category.path);
  const existing = await readGroups(vfs, access, albumsPath, media.idOf);
  const entries = await liveEditEntries(vfs, access, owner.user, category.name);
  result.items = media.items.length;
  result.pending = media.pending;

  // A person's groups keep their members, which planning leaves out.
  const held = new Set<string>();
  for (const group of existing) if (group.pinned) { for (const id of group.memberIds) if (id) held.add(id); }
  const free = media.items.filter((item) => !held.has(item.id));
  const { plan, homes, names, library } = await planScope(vfs, media, owner, {
    strategy: category.settings.group,
    edits: entries.map((entry) => entry.edit),
    items: free,
    granularity: checkpoint?.paramsKey === run.paramsKey ? checkpoint.granularity : {},
  });

  const ctx: WriteContext = {
    vfs,
    access,
    albumsPath,
    owner,
    library,
    names,
    folders: media.folders,
    used: new Set(existing.map((group) => group.slug)),
    dryRun,
    members: options.members === true,
  };
  const written = await writePlan(ctx, plan.groups, existing, result);
  for (const kind of written.kinds) result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
  const covered = new Set<string>(plan.groups.flatMap((group) => group.items.map((item) => item.id)));
  for (const id of held) covered.add(id);
  const indexed = new Set(media.items.map((item) => item.id));
  result.covered = [...covered].filter((id) => indexed.has(id)).length;
  result.watermark = watermark;

  if (!dryRun) {
    const now = new Date().toISOString();
    const pinned: Record<string, string[]> = {};
    for (const group of existing) if (group.pinned) pinned[group.id] = group.memberIds.filter((id): id is string => id !== undefined);
    await writeCheckpoint(vfs, access, albumsPath, owner.owner, {
      lastRunAt: now,
      lastFullAt: now,
      mode: 'full',
      groups: written.kinds.length,
      members: result.covered,
      pending: result.pending,
      byKind: result.byKind,
    }, {
      version: 2,
      paramsKey: run.paramsKey,
      granularity: plan.granularity,
      baselines: plan.baselines,
      dayShots: plan.dayShots,
      segments: plan.segments,
      seeds: plan.seeds,
      pinned,
      homes: Object.fromEntries(homes),
      edits: entries.map((entry) => entry.id),
      watermark,
      recent,
      groupsMark: idFloor(Date.now() + 1),
      items: media.items.length,
      lastMatchAt: new Date(run.started).toISOString(),
      lastFullAt: now,
      lastRunAt: now,
    });
  }
  result.durationMs = Date.now() - run.started;
  return result;
};

// ── the incremental run ─────────────────────────────────────────────────────

/** A changed file: the paths it was or is at, and the instants it was at before the change. */
type Dirty = { paths: Set<string>; times: number[] };

/** The ids of the files an edit names. */
const editIds = (edit: StagingEdit): string[] => {
  switch (edit.op) {
    case 'cut':
      return [edit.after];
    case 'join':
      return [edit.first, edit.last];
    case 'assign':
      return [...edit.items, edit.with];
    case 'dismiss':
      return edit.members;
  }
};

/** An instant as a capture time the timeline places, or undefined. */
const instantOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** A span of the timeline an incremental run plans again: whole segments, and whether its items are read as it is now. */
type Span = { lo: number; hi: number; read: boolean };

/**
 * The spans of the timeline a run plans again, grown from changed instants to the segments of the
 * last run (`segments`) they touch: each span holds whole segments, and lies more than
 * `SEGMENT_GAP_MS` from every segment it does not hold.
 */
class Spans {
  readonly spans: Span[] = [];
  private readonly byDay = new Map<string, Segment>();

  constructor(private readonly segments: Segment[]) {
    for (const segment of segments) for (const day of segment.days) this.byDay.set(day, segment);
  }

  /** Plan the timeline again at `ms`, and at what it touches. */
  add(ms: number): void {
    this.addRange(ms, ms);
  }

  /** Plan the timeline again from `lo` to `hi` as one span, and what it touches. */
  addRange(lo: number, hi: number): void {
    if (this.spans.some((span) => span.lo <= lo && hi <= span.hi)) return;
    this.spans.push({ lo, hi, read: false });
    this.close();
  }

  /** Plan again the segment of the last run that holds `day`, if one does. */
  addDay(day: string): void {
    const segment = this.byDay.get(day);
    if (segment) this.add(segment.start);
  }

  /** Whether `ms` lies in a span. */
  holds(ms: number): boolean {
    return this.spans.some((span) => span.lo <= ms && ms <= span.hi);
  }

  /** The last run's segments the spans hold. */
  replaced(): Segment[] {
    return this.segments.filter((segment) => this.holds(segment.start));
  }

  /** Grow every span to the segments within `SEGMENT_GAP_MS` of it, and join spans that come as close. */
  private close(): void {
    let grown = true;
    while (grown) {
      grown = false;
      for (const span of this.spans) {
        for (const segment of this.segments) {
          if (segment.end < span.lo - SEGMENT_GAP_MS || segment.start > span.hi + SEGMENT_GAP_MS) continue;
          if (segment.start < span.lo || segment.end > span.hi) {
            span.lo = Math.min(span.lo, segment.start);
            span.hi = Math.max(span.hi, segment.end);
            span.read = false;
            grown = true;
          }
        }
      }
      this.spans.sort((a, b) => a.lo - b.lo);
      for (let i = 1; i < this.spans.length; i++) {
        const [before, span] = [this.spans[i - 1], this.spans[i]];
        if (span.lo - before.hi > SEGMENT_GAP_MS) continue;
        before.hi = Math.max(before.hi, span.hi);
        before.read = false;
        this.spans.splice(i--, 1);
        grown = true;
      }
    }
  }
}

/** The lane family a lane's key belongs to: the lanes a run plans again together. */
type FamilyOf = (key: string) => string | undefined;

/**
 * The family of each lane key: an Everyday or clutter lane's year (`loose:2014`), or its month once
 * the year is split (`loose:2014-06`); a period lane's value and folder; an undated lane's folder;
 * a `none` lane's folder and month. Chunks (`#2`) are their lane's. A seed is no lane.
 */
const familyRule = (granularity: Readonly<Record<string, 'year' | 'month'>>, yearLanes: ReadonlySet<string>): FamilyOf => (key) => {
  const base = key.replace(/#\d+$/, '');
  if (base.startsWith('seed:')) return undefined;
  const dated = base.match(/^(loose|clutter):(\d{4})(-\d{2})?$/);
  if (!dated) return base;
  const [, kind, year, month] = dated;
  const yearKey = `${kind}:${year}`;
  return month && granularity[yearKey] === 'month' && !yearLanes.has(yearKey) ? `${yearKey}${month}` : yearKey;
};

/** The lane families an item may go to, by its class: the Everyday lanes of its day, for a timeline item, as it may end up there. */
const familiesOf = (item: PlanItem, cls: ReturnType<typeof classOf>, strategy: StagingCategorySettings['group']['strategy'], family: FamilyOf): string[] => {
  const day = item.precision === 'none' ? '' : dayOf(item);
  switch (cls) {
    case 'timeline':
      return [strategy === 'none' ? `none:${item.folderId}:${day.slice(0, 7)}` : family(`loose:${day.slice(0, 7)}`)!];
    case 'clutter':
      return [item.precision === 'none' ? 'clutter:undated' : family(`clutter:${day.slice(0, 7)}`)!];
    case 'period':
      return [`period:${periodValue(item)}:${item.folderId}`];
    case 'undated':
      return [`undated:${item.folderId}`];
  }
};

/** Whether `group`'s lanes keep their members' classes (Everyday, clutter) a plan cannot find again alone. */
const laneClassOf = (family: string): 'loose' | 'clutter' | undefined => family.startsWith('loose:') ? 'loose' : family.startsWith('clutter:') ? 'clutter' : undefined;

/**
 * One incremental run of the category (see the file's comment), or the reason to plan it whole
 * instead.
 */
const incremental = async (run: Run, checkpoint: Checkpoint, requested: boolean): Promise<OrganizeResult | OrganizeFullReason> => {
  const { vfs, access, owner, category, albumsPath, options } = run;
  const root = category.path;
  const strategy = category.settings.group.strategy;
  const dryRun = options.dryRun === true;
  const result = emptyResult(owner.user, category.name, 'incremental', dryRun);
  const limit = Math.max(FULL_FLOOR, FULL_SHARE * checkpoint.items);

  // ── what changed ──
  const dirty = new Map<string, Dirty>();
  const touch = (id: string, path?: string, time?: number): void => {
    let entry = dirty.get(id);
    if (!entry) dirty.set(id, entry = { paths: new Set(), times: [] });
    if (path !== undefined) entry.paths.add(path);
    if (time !== undefined) entry.times.push(time);
  };
  const seen = new Set<string>();
  const trail = await readTrail(vfs, access, { pathPrefix: root, after: checkpoint.watermark, nodeTypes: TRAIL_TYPES }, new Set(checkpoint.recent), () => true, (records) => {
    for (const record of records) seen.add(ownerOf(record.path) ?? record.nodeId);
    return seen.size <= limit;
  });
  if (trail.over) return 'many';
  const movedIn: string[] = [];
  const ownerPaths = new Set<string>();
  const folders = new Set<string>();
  for (const record of trail.records) {
    if (record.nodeType === 'directory') {
      if (record.op === 'move' && (within(record.path, root) || within(record.fromPath, root))) movedIn.push(record.path);
      else if (record.op === 'update' && record.attrs?.title !== undefined) folders.add(record.nodeId);
      continue;
    }
    if (record.nodeType === 'file') {
      touch(record.nodeId, record.path, instantOf(record.attrs?.takenAtUtc?.from));
      if (record.fromPath !== undefined) touch(record.nodeId, record.fromPath);
    }
    for (const path of [record.path, record.fromPath]) {
      const at = path === undefined ? undefined : ownerOf(path);
      if (within(at, root)) ownerPaths.add(at);
    }
  }
  // A folder moved in, out or within: every file now in it; and the files children of which changed.
  for (const path of movedIn) for (const row of await readScopeFiles(vfs, access, path).catch(() => [])) touch(row.id, row.path);
  for (const [path, id] of await idsAt(vfs, access, [...ownerPaths])) touch(id, path);

  const groupTrail = await readTrail(vfs, access, { pathPrefix: albumsPath, after: checkpoint.groupsMark, nodeTypes: GROUP_TRAIL_TYPES }, new Set(), groupWrite(albumsPath));
  result.records = trail.records.length + groupTrail.records.length;

  const entries = await liveEditEntries(vfs, access, owner.user, category.name);
  const edits = entries.map((entry) => entry.edit);
  const before = new Set(checkpoint.edits);
  const live = new Set(entries.map((entry) => entry.id));
  for (const entry of entries) if (!before.has(entry.id)) { for (const id of editIds(entry.edit)) touch(id); }
  for (const id of checkpoint.edits) {
    if (live.has(id)) continue;
    const node = await vfs.get<{ stagingEdit?: StagingEdit }>(access, `${stagingRoots(owner.user).journalPath}/${id}`).catch(() => undefined);
    if (node?.attrs.stagingEdit) { for (const file of editIds(node.attrs.stagingEdit)) touch(file); }
  }

  // ── the groups, and those others wrote to ──
  const listing = await listGroups(vfs, access, albumsPath);
  const byPath = new Map(listing.map((group) => [group.path, group]));
  const byId = new Map(listing.map((group) => [group.id, group]));
  const pinned = new Map(Object.entries(checkpoint.pinned).map(([id, members]) => [id, new Set(members)]));
  const keepUp = new Map<string, GroupEntry>();
  const touchedSlugs = new Set(
    groupTrail.records.map((record) => (within(record.path, albumsPath) ? record.path : record.fromPath!).slice(albumsPath.length + 1).split('/')[0]),
  );
  const touched = await readLinks(vfs, access, listing.filter((group) => touchedSlugs.has(group.slug)), new Map());
  const pendingGroups: GroupEntry[] = [];
  for (const group of touched) {
    const was = pinned.get(group.id);
    const members = new Set(group.memberIds.filter((id): id is string => id !== undefined));
    if (group.pinned) {
      // A link taken out by hand of a group the organizer kept leaves a file in no group, and which one is not known here.
      if (!was && group.links.length < (group.attrs.autoAlbum?.memberCount ?? 0)) return 'drift';
      // What it holds is a person's now: what it took and what it gave up are planned again.
      for (const id of members) if (!was?.has(id)) touch(id);
      for (const id of was ?? []) if (!members.has(id)) touch(id);
      pinned.set(group.id, members);
      keepUp.set(group.id, group);
    } else {
      for (const id of [...was ?? [], ...members]) touch(id);
      pinned.delete(group.id);
      pendingGroups.push(group);
    }
  }
  for (const [id, members] of pinned) {
    if (byId.has(id)) continue;
    for (const member of members) touch(member);
    pinned.delete(id);
  }
  const held = new Set([...pinned.values()].flatMap((members) => [...members]));

  if (dirty.size > DEFER_ABOVE && run.started - Date.parse(checkpoint.lastRunAt) < DEFER_MS && !requested) {
    result.skipped = 'deferred';
    result.watermark = checkpoint.watermark;
    result.durationMs = Date.now() - run.started;
    return result;
  }
  if (dirty.size > limit) return 'many';

  // ── what that touches, until it is closed ──
  const granularity = checkpoint.granularity;
  const family = familyRule(
    granularity,
    new Set(listing.flatMap((group) => {
      const key = group.attrs.autoAlbum?.key;
      return key && /^(loose|clutter):\d{4}$/.test(key) ? [key] : [];
    })),
  );
  const media = emptyMedia();
  const items = new Map<string, PlanItem>();
  const gone = new Set<string>();
  const planned = new Set<string>();
  const absorbed = new Set<string>();
  const placed = new Set<string>();
  const seeds = new Set(checkpoint.seeds);
  const evaluated = new Set<string>();
  const families = new Set<string>();
  const familiesRead = new Set<string>();
  const fixed = new Map<string, string>();
  const candidates = new Map<string, ExistingGroup>();
  let drifted = false;
  const spans = new Spans(checkpoint.segments);
  const assigns = edits.filter((edit): edit is Extract<StagingEdit, { op: 'assign' }> => edit.op === 'assign');
  const closed = new Set<number>();
  const joins = edits.filter((edit): edit is Extract<StagingEdit, { op: 'join' }> => edit.op === 'join');
  const timeOf = new Map<string, number>();
  const familyGroups = new Map<string, GroupEntry[]>();
  for (const group of listing) {
    const key = group.attrs.autoAlbum?.key;
    const of = key ? family(key) : undefined;
    if (!of || pinned.has(group.id)) continue;
    const list = familyGroups.get(of);
    if (list) list.push(group);
    else familyGroups.set(of, [group]);
  }

  /** The class of a planning item now: in a seed, on the timeline, or in a lane. */
  const classify = (item: PlanItem): 'seed' | 'run' | ReturnType<typeof classOf> =>
    strategy === 'folders' ? 'run' : strategy === 'events' && seeds.has(item.folderId) ? 'seed' : classOf(item, { strategy, folders: media.folders });

  /** Read the files `rows` as planning items, with their signals, those not read yet. */
  const readIds = new Set<string>();
  const readRows = async (rows: FileRow[]): Promise<void> => {
    const fresh = rows.filter((row) => !readIds.has(row.id));
    for (const row of fresh) readIds.add(row.id);
    if (fresh.length === 0) return;
    const read = await readMedia(vfs, access, fresh, root);
    mergeMedia(media, read);
    for (const item of read.items) {
      items.set(item.id, item);
      if (item.precision === 'instant') timeOf.set(item.id, item.timeMs);
    }
  };

  /** The groups holding a link to any of `paths`: those a person keeps to keep up, the others to plan again with what they hold. */
  const holdersOf = async (paths: string[]): Promise<void> => {
    for (let i = 0; i < paths.length; i += LINK_CHUNK) {
      const chunk = paths.slice(i, i + LINK_CHUNK);
      for (const link of await vfs.findLinks(access, chunk, chunk.length * 8 + 1000)) {
        const group = byPath.get(dirname(link.absPath));
        if (!group || candidates.has(group.id)) continue;
        if (pinned.has(group.id)) keepUp.set(group.id, group);
        else pendingGroups.push(group);
      }
    }
  };

  /** The groups to plan again read with their links, and what they hold made part of the run. */
  const takeGroups = async (): Promise<void> => {
    const fresh = [...new Map(pendingGroups.splice(0).filter((group) => !candidates.has(group.id)).map((group) => [group.id, group])).values()];
    for (const group of await readLinks(vfs, access, fresh, media.idOf)) {
      // Edited by hand with no write to its links the trail saw: not as the last run left it.
      if (group.pinned) drifted = true;
      candidates.set(group.id, group);
      const key = group.attrs.autoAlbum?.key;
      const of = key ? family(key) : undefined;
      if (key?.startsWith('seed:')) folders.add(key.slice('seed:'.length));
      else if (of) families.add(of);
      else {
        if (group.attrs.autoAlbum?.folderId && strategy === 'folders') folders.add(group.attrs.autoAlbum.folderId);
        for (const id of group.memberIds) if (id && !planned.has(id) && !fixed.has(id)) touch(id);
      }
    }
  };

  /** Read the changed files not read yet: where they are, what they are, and what held them. */
  const absorb = async (): Promise<void> => {
    const ids = [...dirty.keys()].filter((id) => !absorbed.has(id));
    for (const id of ids) absorbed.add(id);
    const where = await batched(ids, (page) => vfs.resolveIdEntries(access, page));
    const here = new Map<string, { path: string; parentId: string }>();
    for (const id of ids) {
      const paths = where.get(id) ?? [];
      for (const entry of paths) dirty.get(id)!.paths.add(entry.path);
      const inside = paths.find((entry) => within(entry.path, root) && entry.path !== root);
      if (inside) here.set(id, inside);
      else gone.add(id);
    }
    const nodes = await batched([...here.keys()], (page) => vfs.getNodesByIds<FileAttrs>(access, page));
    const parents = await batched([...new Set([...here.values()].map((entry) => entry.parentId))], (page) => vfs.getNodesByIds(access, page));
    const rows: FileRow[] = [];
    for (const [id, entry] of here) {
      const node = nodes.get(id);
      if (!node || node.type !== 'file' || node.attrs.sourceId !== undefined || parents.get(entry.parentId)?.type === 'file') gone.add(id);
      else rows.push({ id, path: entry.path, attrs: node.attrs });
    }
    await readRows(rows);
    for (const id of ids) {
      const item = items.get(id);
      if (!item) gone.add(id);
      if (strategy === 'events') {
        for (const time of dirty.get(id)!.times) spans.add(time);
        if (item?.precision === 'instant') spans.add(item.timeMs);
      }
      // Its folder may be a seed or stop being one, held now or not: a seed counts the files no person keeps.
      if (item) folders.add(item.folderId);
      if (item && !held.has(id)) planned.add(id);
    }
    await holdersOf([...new Set(ids.flatMap((id) => [...dirty.get(id)!.paths]))]);
  };

  /** Whether each folder a change touched is a seed, or (by folder) a run of scans, and its files part of the run when it is. */
  const evaluateFolders = async (): Promise<void> => {
    const todo = [...folders].filter((id) => !evaluated.has(id) && !id.startsWith('dir:'));
    for (const id of todo) evaluated.add(id);
    if (strategy === 'none' || todo.length === 0) return;
    const paths = await batched(todo, (page) => vfs.resolveIdPaths(access, page));
    const nodes = await batched(todo, (page) => vfs.getNodesByIds(access, page));
    for (const id of todo) {
      const path = paths.get(id)?.find((each) => within(each, root));
      const wasSeed = seeds.has(id);
      const seedGroup = listing.find((group) => group.attrs.autoAlbum?.key === `seed:${id}` && !pinned.has(group.id));
      if (seedGroup) pendingGroups.push(seedGroup);
      if (!path || nodes.get(id)?.type !== 'directory') {
        seeds.delete(id);
        continue;
      }
      const below = path.startsWith(`${root}/`) ? path.slice(root.length + 1).split('/') : [];
      const title = (nodes.get(id)?.attrs as { title?: unknown }).title;
      const folder: PlanFolder = { id, path, name: basename(path), depth: below.length, ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}) };
      if (strategy === 'events' && !wasSeed && !isNameable(folder)) continue;
      const rows: FileRow[] = [];
      let after: string | undefined;
      while (true) {
        const page = await vfs.children<FileAttrs>(access, path, { types: ['file'], page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
        for (const entry of page) if (entry.node.attrs.sourceId === undefined) rows.push({ id: entry.node.id, path: `${path}/${entry.name}`, attrs: entry.node.attrs });
        if (page.length < PAGE) break;
        after = page[page.length - 1].name;
      }
      await readRows(rows);
      const inFolder = rows.flatMap((row) => items.get(row.id) ?? []).filter((item) => !held.has(item.id));
      if (strategy === 'folders') {
        for (const item of inFolder) planned.add(item.id);
        await holdersOf(inFolder.map((item) => item.path));
        continue;
      }
      const nowSeed = isNameable(folder) && isSeedFolder(folder, inFolder, edits);
      if (nowSeed !== wasSeed) {
        for (const item of inFolder) touch(item.id, item.path);
        if (nowSeed) seeds.add(id);
        else seeds.delete(id);
      }
      if (nowSeed) {
        for (const item of inFolder) planned.add(item.id);
        await holdersOf(inFolder.map((item) => item.path));
      }
    }
  };

  /** Read the spans not read as they are now: their timeline items are part of the run; one outside them grows them. */
  const readSpans = async (): Promise<void> => {
    for (const span of spans.spans.filter((each) => !each.read)) {
      span.read = true;
      const rows: FileRow[] = [];
      let after: { value: string | null; id: string } | undefined;
      const [from, to] = [new Date(span.lo - SEGMENT_GAP_MS - DAY_MS).toISOString(), new Date(span.hi + SEGMENT_GAP_MS + DAY_MS).toISOString()];
      while (true) {
        const page = await vfs.query(access, {
          within: root,
          types: ['file'],
          where: [{ ref: 'sourceId', op: 'missing' }, { ref: 'takenAtUtc', op: 'gte', value: from }, { ref: 'takenAtUtc', op: 'lte', value: to }],
          orderBy: { ref: 'takenAtUtc', dir: 'asc' },
          ...(after ? { after } : {}),
          limit: PAGE,
        });
        for (const row of page) rows.push({ id: row.id, path: row.absPath, attrs: row.node.attrs as FileAttrs });
        if (page.length < PAGE) break;
        after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
      }
      await readRows(rows);
      const fresh: string[] = [];
      for (const row of rows) {
        const item = items.get(row.id);
        if (!item || held.has(item.id) || item.precision !== 'instant' || classify(item) !== 'timeline') continue;
        // Within a pause of the span it is of the span's segments, and a day it shares with a segment beyond joins that one;
        // further out it is another segment's.
        if (item.timeMs < span.lo - SEGMENT_GAP_MS || item.timeMs > span.hi + SEGMENT_GAP_MS) continue;
        if (!spans.holds(item.timeMs)) spans.add(item.timeMs);
        spans.addDay(dayOf(item));
        if (!planned.has(item.id)) {
          planned.add(item.id);
          fresh.push(item.path);
        }
      }
      await holdersOf(fresh);
    }
    // A run a person joined is planned whole, in one span: both ends, with whatever lies between.
    for (const join of joins) {
      const [first, last] = [timeOf.get(join.first), timeOf.get(join.last)];
      if (first === undefined || last === undefined) continue;
      const [lo, hi] = [Math.min(first, last), Math.max(first, last)];
      if (spans.holds(lo) || spans.holds(hi)) spans.addRange(lo, hi);
    }
  };

  /** Each lane family the run's items were or may be in, with its members a plan leaves as they are. */
  const readFamilies = async (): Promise<void> => {
    for (const id of planned) {
      if (placed.has(id)) continue;
      placed.add(id);
      const item = items.get(id)!;
      const cls = classify(item);
      if (cls !== 'seed' && cls !== 'run') { for (const each of familiesOf(item, cls, strategy, family)) families.add(each); }
    }
    for (const each of [...families].filter((name) => !familiesRead.has(name))) {
      familiesRead.add(each);
      for (const group of familyGroups.get(each) ?? []) if (!candidates.has(group.id)) pendingGroups.push(group);
    }
    await takeGroups();
    for (const group of candidates.values()) {
      const key = group.attrs.autoAlbum?.key;
      const of = key ? family(key) : undefined;
      const lane = of ? laneClassOf(of) ?? 'other' : undefined;
      if (lane) { for (const id of group.memberIds) if (id && !planned.has(id) && !gone.has(id)) fixed.set(id, lane); }
    }
  };

  /** The files an edit puts with a file of the run, made part of it. */
  const closeAssigns = (): void => {
    assigns.forEach((assign, i) => {
      if (closed.has(i)) return;
      const ids = [...assign.items, assign.with];
      if (!ids.some((id) => planned.has(id) || fixed.has(id) || dirty.has(id))) return;
      closed.add(i);
      for (const id of ids) touch(id);
    });
  };

  /** The years whose usual day the spans as planned change, whose every segment is then planned again. */
  const checkBaselines = (): boolean => {
    if (strategy !== 'events') return false;
    const timeline = [...planned].map((id) => items.get(id)!).filter((item) => item.precision === 'instant' && classify(item) === 'timeline').toSorted(compareItems);
    const replacedDays = new Set(spans.replaced().flatMap((segment) => segment.days));
    const shots = new Map(Object.entries(checkpoint.dayShots).filter(([day]) => !replacedDays.has(day)));
    for (const [day, count] of dayShotsOf(timeline)) shots.set(day, count);
    const byYear = new Map<string, number[]>();
    for (const [day, count] of shots) byYear.set(day.slice(0, 4), [...byYear.get(day.slice(0, 4)) ?? [], count]);
    let grown = false;
    for (const [year, counts] of byYear) {
      const was = checkpoint.baselines[year];
      if (was === undefined || baselineOf(counts) === was) continue;
      for (const segment of checkpoint.segments) {
        if (!segment.days.some((day) => day.startsWith(year)) || spans.holds(segment.start)) continue;
        spans.add(segment.start);
        grown = true;
      }
    }
    return grown;
  };

  // Join ends' instants, for the spans to hold a joined run whole.
  const joinEnds = [...new Set(joins.flatMap((join) => [join.first, join.last]))];
  for (const [id, node] of await batched(joinEnds, (page) => vfs.getNodesByIds<FileAttrs>(access, page))) {
    const time = instantOf(node.attrs.takenAtUtc);
    if (time !== undefined) timeOf.set(id, time);
  }

  await takeGroups();
  while (true) {
    if ([...dirty.keys()].some((id) => !absorbed.has(id))) await absorb();
    else if ([...folders].some((id) => !evaluated.has(id) && !id.startsWith('dir:'))) await evaluateFolders();
    else if (spans.spans.some((span) => !span.read)) await readSpans();
    else if (pendingGroups.length > 0) await takeGroups();
    else {
      await readFamilies();
      closeAssigns();
      const settled = ![...dirty.keys()].some((id) => !absorbed.has(id)) && pendingGroups.length === 0 && !spans.spans.some((span) => !span.read);
      if (settled && !checkBaselines()) break;
    }
    if (drifted) return 'drift';
    if (planned.size > limit) return 'many';
  }
  for (const id of planned) if (held.has(id)) planned.delete(id);

  // Every file of a group planned again is planned again, a lane's left in it, or gone: else the groups are not as left.
  const accounted = (id: string) => planned.has(id) || fixed.has(id) || gone.has(id) || (dirty.has(id) && !items.has(id));
  for (const group of candidates.values()) if (group.memberIds.some((id) => id !== undefined && !accounted(id))) return 'drift';

  // ── plan ──
  const fixedIds = [...fixed.keys()].filter((id) => !planned.has(id) && !held.has(id) && !gone.has(id));
  const fixedWhere = await batched(fixedIds, (page) => vfs.resolveIdEntries(access, page));
  const fixedNodes = await batched(fixedIds, (page) => vfs.getNodesByIds<FileAttrs>(access, page));
  const fixedParents = await batched(
    [...new Set(fixedIds.flatMap((id) => fixedWhere.get(id)?.map((entry) => entry.parentId) ?? []))],
    (page) => vfs.getNodesByIds(access, page),
  );
  const fixedRows = fixedIds.flatMap((id): FileRow[] => {
    const entry = fixedWhere.get(id)?.find((each) => within(each.path, root) && fixedParents.get(each.parentId)?.type !== 'file');
    const node = fixedNodes.get(id);
    return entry && node?.type === 'file' && node.attrs.sourceId === undefined ? [{ id, path: entry.path, attrs: node.attrs }] : [];
  });
  const lite = await readMedia(vfs, access, fixedRows, root, false, false);
  mergeMedia(media, lite);
  const lanes = new Map<string, 'loose' | 'clutter'>();
  for (const item of lite.items) {
    const lane = fixed.get(item.id);
    if (lane === 'loose' || lane === 'clutter') lanes.set(item.id, lane);
  }
  const replaced = spans.replaced();
  const replacedDays = new Set(replaced.flatMap((segment) => segment.days));
  const dayShots = new Map(Object.entries(checkpoint.dayShots).filter(([day]) => !replacedDays.has(day)));
  const planItems = [...[...planned].map((id) => items.get(id)!), ...lite.items];
  const homes = new Map(Object.entries(checkpoint.homes));
  const { years, points } = pointsByYearOf(planItems);
  const missing = [...new Set(years)].filter((year) => !homes.has(year)).sort();
  if (missing.length > 0) {
    const found = await homesByYear(vfs, owner.access, { user: owner.user, years: missing, pointsByYear: points });
    for (const year of missing) {
      const earlier = [...homes.keys()].filter((known) => known < year).sort().pop();
      const home = found.get(year) ?? (earlier ? { ...homes.get(earlier)!, source: 'previous' as const } : undefined);
      if (home) homes.set(year, home);
    }
  }
  const library = await libraryOf(vfs, access, owner, planItems);
  const { plan, names } = await planWith(vfs, media, owner, {
    strategy: category.settings.group,
    edits,
    items: planItems,
    granularity,
    homes,
    library,
    seedFolders: seeds,
    dayShots,
    lanes,
  });

  // ── pair and write ──
  // A person's group stays theirs while it holds a member; with none left it goes, as in a full build.
  const keep = await readLinks(vfs, access, [...keepUp.values()].filter((group) => byId.has(group.id)), media.idOf);
  for (const group of keep) group.pinned = group.gone.length < group.links.length;
  const ctx: WriteContext = {
    vfs,
    access,
    albumsPath,
    owner,
    library,
    names,
    folders: media.folders,
    used: new Set(listing.map((group) => group.slug)),
    dryRun,
    members: options.members === true,
  };
  await writePlan(ctx, plan.groups, [...candidates.values(), ...keep], result);
  result.items = planned.size;
  result.covered = plan.groups.reduce((sum, group) => sum + group.items.filter((item) => planned.has(item.id)).length, 0);
  result.windows = spans.spans.length;
  result.pinned = pinned.size;
  result.pending = await countPending(vfs, access, root);
  const watermark = nextWatermark(checkpoint.watermark, trail.records, run.started);
  result.watermark = dryRun ? checkpoint.watermark : watermark;

  for (const group of keep) {
    const members = group.memberIds.filter((id): id is string => id !== undefined);
    if (members.length === 0) pinned.delete(group.id);
    else pinned.set(group.id, new Set(members));
  }
  const counts = countGroups(dryRun ? listing : await listGroups(vfs, access, albumsPath), pinned);
  result.byKind = counts.byKind;
  if (!dryRun) {
    const segments = [...checkpoint.segments.filter((segment) => !replaced.includes(segment)), ...plan.segments].sort((a, b) => a.start - b.start);
    for (const [day, count] of Object.entries(plan.dayShots)) dayShots.set(day, count);
    const recent = [...new Set([...checkpoint.recent, ...trail.records.map((record) => record.id)])].filter((id) => id > watermark).sort().slice(-RECENT_MAX);
    const now = new Date().toISOString();
    await writeCheckpoint(vfs, access, albumsPath, owner.owner, {
      lastRunAt: now,
      lastFullAt: checkpoint.lastFullAt,
      mode: 'incremental',
      groups: counts.groups,
      members: counts.members,
      pending: result.pending,
      byKind: counts.byKind,
    }, {
      ...checkpoint,
      granularity: plan.granularity,
      baselines: plan.baselines,
      dayShots: Object.fromEntries([...dayShots].sort(([a], [b]) => a.localeCompare(b))),
      segments,
      seeds: [...seeds],
      pinned: Object.fromEntries([...pinned].map(([id, members]) => [id, [...members]])),
      homes: Object.fromEntries(homes),
      edits: entries.map((entry) => entry.id),
      watermark,
      recent,
      groupsMark: idFloor(Date.now() + 1),
      items: counts.members,
      lastMatchAt: new Date(run.started).toISOString(),
      lastRunAt: now,
    });
  }
  result.durationMs = Date.now() - run.started;
  return result;
};

// ── a run, and asking for one ───────────────────────────────────────────────

/** Why a run of the category with `checkpoint` plans it whole before reading what changed, if it does. */
const fullReason = (run: Run, checkpoint: Checkpoint | undefined): OrganizeFullReason | undefined => {
  if (!checkpoint) return 'first';
  if (checkpoint.paramsKey !== run.paramsKey) return 'settings';
  if (run.options.full) return 'asked';
  if (!isAdmin(run.access)) return 'trail';
  if (run.started - Date.parse(checkpoint.lastFullAt) > FULL_EVERY_MS) return 'week';
  return undefined;
};

/**
 * One run over `category` for `owner`, holding the category's lock: incremental, or a full build
 * when one is due or the incremental run finds it must (see the file's comment). Then, with the
 * lock let go, the groups it wrote are matched against the library, with those around the days of
 * library albums whose profiles changed since the last run; matching an administrator's run only,
 * as it reads every album's profile. A group matching misses (a failure, or a run of someone else)
 * is due a match, which `staging match --stale` finds. A dry run reads and plans, and writes
 * nothing.
 */
export const organizeCategory = async (cmd: Command, owner: OwnerContext, category: CategoryEntry, options: OrganizeOptions = {}): Promise<OrganizeResult> => {
  const albumsPath = categoryAlbumsPath(owner.user, category.name);
  const run: Run = {
    cmd,
    vfs: cmd.sys.vfs,
    access: cmd.access,
    owner,
    category,
    albumsPath,
    paramsKey: paramsKeyOf(category.settings),
    options,
    started: Date.now(),
  };
  let matchedSince: string | undefined;
  const result = await withCategoryLock(albumsPath, async () => {
    const checkpoint = await readCheckpoint(run.vfs, run.access, albumsPath);
    matchedSince = checkpoint?.lastMatchAt;
    const due = fullReason(run, checkpoint);
    if (due || !checkpoint) return await fullBuild(run, checkpoint, due ?? 'first');
    const requested = await readRequest(run.vfs, run.access, albumsPath);
    const outcome = await incremental(run, checkpoint, requested !== undefined && requested > checkpoint.lastRunAt);
    return typeof outcome === 'string' ? await fullBuild(run, checkpoint, outcome) : outcome;
  });
  if (options.dryRun || result.skipped || !isAdmin(run.access)) return result;
  try {
    const written = result.groups.flatMap((group) => (group.action === 'create' || group.action === 'update') && group.path ? [group.path] : []);
    const around = matchedSince ? await groupsChangedSince(cmd, owner.user, category.name, matchedSince) : [];
    result.matched = (await matchGroups(cmd, [...new Set([...written, ...around])])).matched;
  } catch (error) {
    await cmd.writeError(`staging organize: ${owner.user}/${category.name}: matching: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  result.durationMs = Date.now() - run.started;
  return result;
};

/**
 * What waits for a run of the category, if anything: a category never organized (or whose
 * checkpoint is of an older shape, or whose settings changed), a week since its last full build,
 * edits made or undone since its last run, or records in its audit trail (or writes to its groups
 * by others) the last run did not apply. Reads the trail, so only for an administrator.
 */
const waiting = async (vfs: Vfs, access: Access, user: string, category: CategoryEntry): Promise<StagingQueued['why'] | undefined> => {
  const albumsPath = categoryAlbumsPath(user, category.name);
  const checkpoint = await readCheckpoint(vfs, access, albumsPath);
  if (!checkpoint || checkpoint.paramsKey !== paramsKeyOf(category.settings)) return 'first';
  if (Date.now() - Date.parse(checkpoint.lastFullAt) > FULL_EVERY_MS) return 'week';
  const entries = await liveEditEntries(vfs, access, user, category.name);
  const live = entries.map((entry) => entry.id);
  if (live.length !== checkpoint.edits.length || live.some((id, i) => checkpoint.edits[i] !== id)) return 'edits';
  const recent = new Set(checkpoint.recent);
  let after = checkpoint.watermark;
  while (true) {
    const page = await vfs.audit(access, { pathPrefix: category.path, after, nodeTypes: TRAIL_TYPES, limit: TRAIL_PAGE });
    if (page.some((record) => !recent.has(record.id))) return 'changes';
    if (page.length < TRAIL_PAGE) break;
    after = page[page.length - 1].id;
  }
  const groupTrail = await readTrail(vfs, access, { pathPrefix: albumsPath, after: checkpoint.groupsMark, nodeTypes: GROUP_TRAIL_TYPES }, new Set(), groupWrite(albumsPath));
  return groupTrail.records.length > 0 ? 'changes' : undefined;
};

/**
 * Ask for a run of `category` of `user` (`staging organize --queue`): its request written, as the
 * caller, which the bridge turns into the fact that starts the pipeline's run. With `ifPending`,
 * only when something waits for one (`waiting`), which needs an administrator.
 */
export const queueRun = async (cmd: Command, user: string, category: CategoryEntry, ifPending: boolean): Promise<StagingQueued> => {
  const { vfs } = cmd.sys;
  const albumsPath = categoryAlbumsPath(user, category.name);
  const why = ifPending ? await waiting(vfs, cmd.access, user, category) : undefined;
  if (ifPending && why === undefined) return { user, category: category.name, queued: false };
  const home = await vfs.get(cmd.access, stagingRoots(user).homePath);
  const at = new Date().toISOString();
  await writeRequest(vfs, cmd.access, albumsPath, { uid: home.props.uid, gid: home.props.gid }, at);
  return { user, category: category.name, queued: true, requestedAt: at, ...(why ? { why } : {}) };
};

/** Record that a category's last run failed, keeping what the summary said before. */
export const recordFailure = async (cmd: Command, owner: OwnerContext, category: CategoryEntry, error: string): Promise<void> => {
  const albumsPath = categoryAlbumsPath(owner.user, category.name);
  const before = await readOrganizerSummary(cmd.sys.vfs, cmd.access, albumsPath);
  const now = new Date().toISOString();
  await writeCheckpoint(cmd.sys.vfs, cmd.access, albumsPath, owner.owner, {
    ...(before ?? { lastFullAt: now, mode: 'full', groups: 0, members: 0, pending: 0, byKind: {} }),
    lastRunAt: now,
    error,
  });
};

/**
 * Put the staged media `paths` of `category`, which a person just said are no group of their own,
 * into the lanes the organizer would give them, holding the category's lock (the caller holds
 * it): each joins its lane's group, and a lane not there yet is made. Answers the groups made and
 * changed.
 */
export const fileIntoLanes = async (
  cmd: Command,
  user: string,
  category: CategoryEntry,
  owner: { uid: number; gid: number },
  rows: FileRow[],
  edits: StagingEdit[],
): Promise<{ created: string[]; changed: string[] }> => {
  const { vfs } = cmd.sys;
  const access = cmd.access;
  const albumsPath = categoryAlbumsPath(user, category.name);
  const media = await readMedia(vfs, access, rows, category.path);
  const checkpoint = await readCheckpoint(vfs, access, albumsPath);
  const plan = planCategory(media.items, {
    strategy: category.settings.group.strategy,
    significance: category.settings.group.significance,
    edits,
    folders: media.folders,
    granularity: checkpoint?.granularity ?? {},
  });
  const existing = await readGroups(vfs, access, albumsPath, media.idOf);
  const byKey = new Map(existing.filter((group) => !group.pinned && group.attrs.autoAlbum?.key).map((group) => [group.attrs.autoAlbum!.key!, group]));
  const used = new Set(existing.map((group) => group.slug));
  const now = new Date().toISOString();
  const out = { created: [] as string[], changed: [] as string[] };
  for (const group of plan.groups) {
    const into = group.key ? byKey.get(group.key) : undefined;
    const members = group.items.map((item) => item.path);
    if (into?.attrs.autoAlbum) {
      const names = new Set([COVER_LINK_NAME, ...into.links.map((link) => link.name)]);
      const have = new Set(into.links.map((link) => link.target));
      const adding = group.items.filter((item) => !have.has(item.path));
      if (adding.length === 0) continue;
      await vfs.createTree(access, into.path, memberLinkSpecs(adding.map((item) => item.path), names, owner));
      const meta = into.attrs.autoAlbum;
      await vfs.update(access, into.path, {
        attrs: {
          autoAlbum: {
            ...meta,
            memberKey: toggleMembers(meta.memberKey, adding.map((item) => item.id)),
            memberCount: meta.memberCount + adding.length,
            generatedAt: now,
          },
        },
      });
      out.changed.push(into.path);
      continue;
    }
    const name = group.lane ? laneName(group.lane) : formatDates(group.items.flatMap((item) => item.takenAt ?? [])) ?? basename(group.items[0].folder);
    const slug = freeSlug(slugBase(group, media.folders), used);
    const cover = coverOf(group);
    await vfs.createTree(access, albumsPath, [
      groupSpec(slug, { name, autoAlbum: { ...metaOf(group, name, undefined, cover.rule), generatedAt: now } }, members, owner, cover.path),
    ]);
    out.created.push(`${albumsPath}/${slug}`);
  }
  return out;
};
