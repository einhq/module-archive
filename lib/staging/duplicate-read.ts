/**
 * Reading a staging inbox's duplicate sets from the findings its files carry
 * (`@archive/staging/duplicates`), a page at a time: `staging duplicates` and what
 * `staging dedupe` resolves.
 *
 * A page is one class of findings — copies of library photos, copies within the inbox, look-alikes
 * of library photos, look-alikes within the inbox — read off the `duplicate_found` index in
 * node-id order, within the folder asked for. A copy's set is its original and every staged copy
 * naming it, found by one indexed lookup of their checksum; a look-alike's set is the file and the
 * files its finding lists. A set is answered on the page of its first file in the folder (its
 * anchor) — for look-alikes, the smallest id among the staged ones of the class alike to each
 * other — so across pages each set comes once, and a file outside the folder never hides one. A
 * page of N sets is one keyset query (and more when sets have several files), one lookup of their
 * checksums or look-alikes, and four batched reads for the whole page: the files' children
 * (thumbnails, places, comments, people), the reader's stars, and the library albums holding the
 * library files. A suggested group is read whole: the sets of its members, at most
 * `GROUP_SETS_MAX`; so are staged files named one by one, at most `FILE_SETS_MAX`. What each set keeps, drops and would merge is
 * `@archive/staging/duplicate-rules`'.
 */
import type { DuplicateCounts, DuplicateKind, DuplicateMember, DuplicatePage, DuplicateSet, DuplicateWhere } from '@archive/media/api';
import { isLibraryPath } from '@archive/paths';
import { POSITION_CHILD } from '@archive/location/location-link';
import { albumMembers } from '@archive/media/album-members';
import { COMMENTS_DIR, PEOPLE_DIR } from '@archive/media/merge-duplicates';
import { displaySize } from '@archive/media/near-duplicates';
import { SIDECAR_CHILD } from '@archive/media/paired-sidecar';
import { decideExactSet, decideNearSet, type NearRuleFile, type RuleFile } from '@archive/staging/duplicate-rules';
import { DUPLICATE_ATTR, findingOf, inboxOf, separatedFrom, type TwinNode, twinsOfMany } from '@archive/staging/duplicates';
import { parseStagedPath, stagingRoots } from '@archive/staging/paths';
import type { AttrCondition, AttrRef, Command, NodeQuery } from '@ein/client';
import { verifyAccess } from '@ein/client';
import { basename, dirname } from '@std/path';

type Vfs = Command['sys']['vfs'];

/** Sets a page holds unless asked for fewer, and at most. */
export const DUPLICATE_PAGE = 50;
export const DUPLICATE_PAGE_MAX = 200;

/** Sets a suggested group's read answers at most. */
export const GROUP_SETS_MAX = 500;

/** Staged files whose sets one read takes at most. */
export const FILE_SETS_MAX = 200;

/** A class of findings: what the files are, and where what they copy or look like lies. */
type DuplicateClass = { kind: DuplicateKind; where: DuplicateWhere };

/** The classes, in the order an unfiltered read pages them. */
const DUPLICATE_CLASSES: DuplicateClass[] = [
  { kind: 'exact', where: 'library' },
  { kind: 'exact', where: 'inbox' },
  { kind: 'near', where: 'library' },
  { kind: 'near', where: 'inbox' },
];

/** Rows a page examines per set it holds at most, before it ends short with a cursor. */
const ROW_BUDGET = 10;

/** Index rows read at once, at least. */
const MIN_BATCH = 32;

/** Links one lookup of the page's stars returns at most. */
const LINK_LIMIT = 100_000;

const THUMBNAILS_DIR = 'thumbnails';

/** An album's lone child that holds its members. */
const FILES_DIR = 'files';

const field = (name: string): AttrRef => ({ path: [DUPLICATE_ATTR, name] });

/**
 * Where a read looks: `user`'s inbox and a folder of it, `whole` when that is the inbox's `files/`;
 * or a suggested group of it (`path`), whose members (`members`, by id) are the files read.
 */
export type DuplicateScope = { user: string; path: string; whole: boolean; members?: ReadonlySet<string> };

/** `path` as a scope of `user`'s inbox: its `files/` or anything under it. Throws for anything else. */
export const duplicateScope = (user: string, path: string): DuplicateScope => {
  const { filesPath } = stagingRoots(user);
  const scope = path.replace(/\/+$/, '');
  if (scope === filesPath) return { user, path: scope, whole: true };
  if (inboxOf(scope) !== user) throw new Error(`not in ${user}'s staging files: ${path}`);
  return { user, path: scope, whole: false };
};

/** Whether `path` is a suggested group of `user`'s: `albums/<category>/<slug>`. */
export const isGroupPath = (user: string, path: string): boolean => {
  const parsed = parseStagedPath(path);
  return parsed?.user === user && parsed.area === 'albums' && parsed.category !== undefined && /^[^./][^/]*$/.test(parsed.rest);
};

/** The suggested group `path` of `user`'s as a scope: its members. Throws for one that is not a group. */
export const groupScope = async (cmd: Command, user: string, path: string): Promise<DuplicateScope> => {
  const group = path.replace(/\/+$/, '');
  if (!isGroupPath(user, group)) throw new Error(`not a suggested group of ${user}'s: ${path}`);
  const { members } = await albumMembers(cmd, group);
  return { user, path: group, whole: false, members: new Set(members.map((member) => member.node.id)) };
};

/** Where a read goes on: the class, and the last row examined in it (none: from its start). */
type Cursor = DuplicateClass & { after: string | null };

const encodeCursor = (cursor: Cursor): string => `${cursor.kind}:${cursor.where}:${cursor.after ?? ''}`;

const decodeCursor = (raw: string): Cursor => {
  const match = raw.match(/^(exact|near):(library|inbox):([^:]*)$/);
  if (!match) throw new Error(`invalid cursor '${raw}'`);
  return { kind: match[1] as DuplicateKind, where: match[2] as DuplicateWhere, after: match[3] === '' ? null : match[3] };
};

/** The key of the set of kind `kind` named by `id`: an exact set's original, a near set's anchor. */
export const setKey = (kind: DuplicateKind, id: string): string => `${kind}:${id}`;

/** What a set key names. Throws for one that is not a key. */
export const parseSetKey = (key: string): { kind: DuplicateKind; id: string } => {
  const match = key.match(/^(exact|near):([^:/]+)$/);
  if (!match) throw new Error(`not a duplicate set: ${key}`);
  return { kind: match[1] as DuplicateKind, id: match[2] };
};

/** Whether `raw` is a set key rather than a path. */
export const isSetKey = (raw: string): boolean => /^(exact|near):/.test(raw);

/** The conditions of `user`'s findings of one kind, and of one class when `where` is given. */
const classConditions = (user: string, kind: DuplicateKind, where?: DuplicateWhere): AttrCondition[] => [
  { ref: field('inbox'), op: 'eq', value: user },
  { ref: field('kind'), op: 'eq', value: kind },
  ...(where ? [{ ref: field('where'), op: 'eq' as const, value: where }] : []),
];

/**
 * One class's rows after `after`, in id order: within the folder, or for the whole inbox straight
 * off the index, as every finding of the inbox lies in it (a row that no longer does is dropped by
 * the reader).
 */
const classQuery = (scope: DuplicateScope, which: DuplicateClass, after: string | null, limit: number): NodeQuery => ({
  ...(scope.whole ? {} : { within: scope.path }),
  types: ['file'],
  where: classConditions(scope.user, which.kind, which.where),
  ...(after !== null ? { after: { value: null, id: after } } : {}),
  limit,
});

/** Whether a file lies in the scope: among a group's members, or in the folder. */
const inScope = (scope: DuplicateScope, file: { id: string; path: string }): boolean => scope.members ? scope.members.has(file.id) : file.path.startsWith(`${scope.path}/`);

/** An exact set as found: its class, its original (undefined when it is not where the copies say), and its copies. */
type FoundExact = { kind: 'exact'; where: DuplicateWhere; originalId: string; sha256: string; original?: TwinNode; copies: TwinNode[] };

/** A near set as found: its anchor, and the files its finding lists that are where it says, with how alike each is. */
type FoundNear = { kind: 'near'; where: DuplicateWhere; anchor: TwinNode; peers: { twin: TwinNode; score: number }[] };

type FoundSet = FoundExact | FoundNear;

/**
 * The set of the original `originalId` among `twins`, the media originals with its copies' bytes:
 * the original when it lies where `where` says, and every twin staged in `user`'s inbox whose
 * finding, made for these bytes, names it there.
 */
const setAmong = (user: string, where: DuplicateWhere, originalId: string, sha256: string, twins: TwinNode[]): FoundExact => {
  const original = twins.find((twin) => twin.id === originalId);
  const placed = original && (where === 'library' ? isLibraryPath(original.path) : inboxOf(original.path) === user);
  const copies = twins.filter((twin) => {
    const finding = findingOf(twin.attrs);
    return finding?.inbox === user && finding.kind === 'exact' && finding.where === where && finding.of === originalId && finding.sha256 === sha256 &&
      inboxOf(twin.path) === user;
  });
  return { kind: 'exact', where, originalId, sha256, ...(placed ? { original } : {}), copies };
};

/**
 * The near sets of `rows` (staged files with near findings in `scope`'s inbox) as `reader` finds
 * them: each row's look-alikes that are still in the library or staged in the inbox as originals,
 * and not separated from it since. With `anchored`, only the rows that anchor their set: in the
 * scope, with no staged look-alike of a smaller id in the scope and the same class listing it
 * back. One batched read of every row's look-alikes and their paths.
 */
const nearSetsOf = async (cmd: Command, scope: DuplicateScope, rows: TwinNode[], anchored: boolean): Promise<FoundNear[]> => {
  const { vfs } = cmd.sys;
  const ids = [...new Set(rows.flatMap((row) => (findingOf(row.attrs)?.peers ?? []).map((peer) => peer.id)))];
  const [nodes, paths] = ids.length > 0
    ? await Promise.all([vfs.getNodesByIds(cmd.access, ids), vfs.resolveIdPaths(cmd.access, ids)])
    : [new Map(), new Map<string, string[]>()];
  const sets: FoundNear[] = [];
  for (const row of rows) {
    const finding = findingOf(row.attrs);
    if (finding?.kind !== 'near' || finding.inbox !== scope.user || inboxOf(row.path) !== scope.user) continue;
    const apart = new Set(separatedFrom(row.attrs));
    const peers: FoundNear['peers'] = [];
    for (const peer of finding.peers ?? []) {
      const node = nodes.get(peer.id);
      const path = paths.get(peer.id)?.find((each) => isLibraryPath(each) || inboxOf(each) === scope.user);
      if (!node || path === undefined || apart.has(peer.id)) continue;
      const attrs = node.attrs as Record<string, unknown>;
      if (separatedFrom(attrs).includes(row.id)) continue;
      if (inboxOf(path) === scope.user && findingOf(attrs)?.of !== undefined) continue;
      peers.push({ twin: { id: peer.id, path, attrs, props: node.props }, score: peer.score });
    }
    if (peers.length === 0) continue;
    if (anchored) {
      if (!inScope(scope, row)) continue;
      const before = peers.some(({ twin }) => {
        const theirs = findingOf(twin.attrs);
        return twin.id < row.id && inboxOf(twin.path) === scope.user && inScope(scope, twin) && theirs?.kind === 'near' && theirs.where === finding.where &&
          (theirs.peers ?? []).some((each) => each.id === row.id);
      });
      if (before) continue;
    }
    sets.push({ kind: 'near', where: finding.where ?? 'inbox', anchor: row, peers });
  }
  return sets;
};

/** The sets found by a read, each with its anchor, and where the next read goes on. */
type Found = { sets: { set: FoundSet; at: string }[]; next: Cursor | null };

const twinOfRow = (row: { id: string; absPath: string; node: { attrs: unknown; props: TwinNode['props'] } }): TwinNode => ({
  id: row.id,
  path: row.absPath,
  attrs: row.node.attrs as Record<string, unknown>,
  props: row.node.props,
});

/**
 * Up to `limit` sets anchored in the scope, from `start` on, class by class in `classes`' order.
 * Ends short, with a cursor, once `limit × ROW_BUDGET` rows were examined.
 */
const findSets = async (cmd: Command, scope: DuplicateScope, classes: DuplicateClass[], start: Cursor | undefined, limit: number): Promise<Found> => {
  const { vfs } = cmd.sys;
  const sets: Found['sets'] = [];
  const budget = limit * ROW_BUDGET;
  let examined = 0;
  const first = start ? classes.findIndex((each) => each.kind === start.kind && each.where === start.where) : 0;
  if (first < 0) throw new Error(`the cursor is for another class: ${start!.kind} ${start!.where}`);
  for (let index = first; index < classes.length; index++) {
    const which = classes[index];
    let after = index === first && start ? start.after : null;
    /** Each exact set looked at in this class, by its original, and its anchor (none when it has none in scope). */
    const anchors = new Map<string, string | undefined>();
    for (;;) {
      const batch = Math.min(DUPLICATE_PAGE_MAX, Math.max(MIN_BATCH, 2 * (limit - sets.length)));
      const rows = await vfs.query(cmd.access, classQuery(scope, which, after, batch));
      /** The set each row anchors, by the row's id. */
      const pending = new Map<string, FoundSet>();
      if (which.kind === 'exact') {
        const fresh = new Map<string, string>();
        for (const row of rows) {
          const finding = findingOf(row.node.attrs as Record<string, unknown>);
          const sha256 = (row.node.attrs as { sha256?: unknown }).sha256;
          if (finding?.of !== undefined && typeof sha256 === 'string' && !anchors.has(finding.of)) fresh.set(finding.of, sha256);
        }
        const twins = await twinsOfMany(cmd.sys.vfs, cmd.access, [...fresh.values()]);
        for (const [originalId, sha256] of fresh) {
          const set = setAmong(scope.user, which.where, originalId, sha256, twins.get(sha256) ?? []);
          const anchor = set.copies.filter((copy) => inScope(scope, copy)).map((copy) => copy.id).sort()[0];
          anchors.set(originalId, anchor);
          if (anchor !== undefined) pending.set(anchor, set);
        }
      } else {
        for (const set of await nearSetsOf(cmd, scope, rows.map(twinOfRow), true)) pending.set(set.anchor.id, set);
      }
      for (const row of rows) {
        examined++;
        after = row.id;
        const set = pending.get(row.id);
        if (set) sets.push({ set, at: row.id });
        if (sets.length === limit || examined >= budget) return { sets, next: { ...which, after: row.id } };
      }
      if (rows.length < batch) break;
    }
  }
  return { sets, next: null };
};

/** Which of `paths` the reader has starred: the targets of their links in `$HOME/stars/`. */
const starredAmong = async (cmd: Command, paths: string[]): Promise<Set<string>> => {
  const home = cmd.env.HOME;
  if (!home || home === '/' || paths.length === 0) return new Set();
  const stars = `${home}/stars/`;
  const links = await cmd.sys.vfs.findLinks(cmd.access, paths, LINK_LIMIT);
  return new Set(links.filter((link) => link.absPath.startsWith(stars)).map((link) => link.target));
};

/**
 * The library album holding each of `files` (library files, by id and path): the album its
 * parent is, or whose `files/` its parent is. One batched read of parents, one of their nodes, and
 * for `files/` parents one more of each.
 */
const albumsHolding = async (vfs: Vfs, access: Command['access'], files: { id: string; path: string }[]): Promise<Map<string, { path: string; name: string }>> => {
  const held = new Map<string, { path: string; name: string }>();
  if (files.length === 0) return held;
  const parents = await vfs.getParentLinksByIds(access, files.map((file) => file.id));
  const parentOf = new Map(files.flatMap((file) => {
    const link = parents.get(file.id)?.[0];
    return link ? [[file.id, link.parentId] as const] : [];
  }));
  const nodes = await vfs.getNodesByIds(access, [...new Set(parentOf.values())]);
  const viaFiles = files.filter((file) => {
    const parent = nodes.get(parentOf.get(file.id) ?? '');
    return parent?.type === 'directory' && basename(dirname(file.path)) === FILES_DIR;
  });
  const grand = viaFiles.length > 0 ? await vfs.getParentLinksByIds(access, [...new Set(viaFiles.map((file) => parentOf.get(file.id)!))]) : new Map();
  const grandIds = [...new Set([...grand.values()].flatMap((links) => links[0] ? [links[0].parentId] : []))];
  const grandNodes = grandIds.length > 0 ? await vfs.getNodesByIds(access, grandIds) : new Map();
  const nameOf = (attrs: Record<string, unknown>, path: string) => typeof attrs.name === 'string' && attrs.name ? attrs.name : basename(path);
  for (const file of files) {
    const parentId = parentOf.get(file.id);
    const parent = parentId !== undefined ? nodes.get(parentId) : undefined;
    if (parent?.type === 'album') {
      held.set(file.id, { path: dirname(file.path), name: nameOf(parent.attrs, dirname(file.path)) });
      continue;
    }
    const albumId = parentId !== undefined ? grand.get(parentId)?.[0]?.parentId : undefined;
    const album = albumId !== undefined ? grandNodes.get(albumId) : undefined;
    if (album?.type === 'album' && viaFiles.includes(file)) {
      const path = dirname(dirname(file.path));
      held.set(file.id, { path, name: nameOf(album.attrs, path) });
    }
  }
  return held;
};

/** A file's attrs as the page reads them. */
type MemberAttrs = {
  name?: string;
  mimetype?: string;
  width?: number;
  height?: number;
  angle?: number;
  duration?: number;
  takenAt?: string;
  takenAtUtc?: string;
  takenAtSource?: string;
  devicePath?: string;
  size?: number;
  sha256?: string;
  description?: string;
  whenManual?: string;
  positionManual?: unknown;
  labels?: unknown;
};

/** A set as read: the answer's set, and its members (with the copies it would drop) as the read found them. */
export type ReadSet = { set: DuplicateSet; members: TwinNode[] };

/** The members of a found set: an exact set's original and copies, a near set's anchor and look-alikes. */
const membersOf = (set: FoundSet): TwinNode[] =>
  set.kind === 'exact' ? [...(set.original ? [set.original] : []), ...set.copies] : [set.anchor, ...set.peers.map((peer) => peer.twin)];

/** Where a member lies: a library file of an exact set's original, or any library file of a near set; else staged. */
const placeOf = (set: FoundSet, twin: TwinNode): DuplicateWhere =>
  set.kind === 'exact' ? (twin === set.original && set.where === 'library' ? 'library' : 'inbox') : isLibraryPath(twin.path) ? 'library' : 'inbox';

/**
 * The answer's sets for `found`, with `chosen` kept where a set holds it: every member's
 * children, the reader's stars, the library files' albums, and the staged look-alikes' byte
 * copies read once for all of them.
 */
const buildSets = async (cmd: Command, scope: DuplicateScope, found: FoundSet[], chosen?: string): Promise<ReadSet[]> => {
  const { vfs } = cmd.sys;
  const members = found.flatMap(membersOf);
  const ids = [...new Set(members.map((member) => member.id))];
  const library = found.flatMap((set) => membersOf(set).filter((twin) => placeOf(set, twin) === 'library'));
  const nearStaged = found.flatMap((set) => set.kind === 'near' ? membersOf(set).filter((twin) => placeOf(set, twin) === 'inbox') : []);
  const [children, starred, albums, twins] = await Promise.all([
    ids.length > 0 ? vfs.getChildLinksByIds(cmd.access, ids) : Promise.resolve(new Map<string, { name: string }[]>()),
    starredAmong(cmd, [...new Set(members.map((member) => member.path))]),
    albumsHolding(vfs, cmd.access, [...new Map(library.map((twin) => [twin.id, twin])).values()]),
    twinsOfMany(vfs, cmd.access, nearStaged.flatMap((twin) => typeof twin.attrs.sha256 === 'string' ? [twin.attrs.sha256] : [])),
  ]);
  const has = (id: string, name: string) => children.get(id)?.some((child) => child.name === name) ?? false;
  /** A staged look-alike's byte copies in the inbox, which go with it. */
  const copiesOf = (twin: TwinNode): TwinNode[] =>
    (twins.get(String(twin.attrs.sha256)) ?? []).filter((each) => {
      const finding = findingOf(each.attrs);
      return each.id !== twin.id && finding?.inbox === scope.user && finding.kind === 'exact' && finding.of === twin.id && inboxOf(each.path) === scope.user;
    });

  const ruleFile = (twin: TwinNode, place: DuplicateWhere): RuleFile => {
    const attrs = twin.attrs as MemberAttrs;
    return {
      id: twin.id,
      place,
      inScope: place === 'inbox' && inScope(scope, twin),
      ...(typeof attrs.size === 'number' ? { size: attrs.size } : {}),
      ...(typeof attrs.description === 'string' && attrs.description ? { description: attrs.description } : {}),
      ...(typeof attrs.whenManual === 'string' && attrs.whenManual ? { whenManual: attrs.whenManual } : {}),
      ...(attrs.positionManual ? { positionManual: true } : {}),
      hasPosition: has(twin.id, POSITION_CHILD),
      labels: Array.isArray(attrs.labels) ? attrs.labels.filter((label): label is string => typeof label === 'string') : [],
      starred: starred.has(twin.path),
      hasComments: has(twin.id, COMMENTS_DIR),
      hasPeople: has(twin.id, PEOPLE_DIR),
      hasSidecar: has(twin.id, SIDECAR_CHILD),
    };
  };
  const nearFile = (twin: TwinNode, place: DuplicateWhere, inSet: ReadonlySet<string>): NearRuleFile => {
    const attrs = twin.attrs as MemberAttrs;
    return {
      ...ruleFile(twin, place),
      name: basename(twin.path),
      ...(typeof attrs.mimetype === 'string' ? { mimetype: attrs.mimetype } : {}),
      ...displaySize(attrs.width, attrs.height, attrs.angle),
      ...(typeof attrs.takenAtUtc === 'string' ? { takenAtUtc: attrs.takenAtUtc } : {}),
      ...(typeof attrs.takenAtSource === 'string' ? { takenAtSource: attrs.takenAtSource } : {}),
      ...(typeof attrs.devicePath === 'string' ? { device: attrs.devicePath } : {}),
      alike: place === 'inbox' ? (findingOf(twin.attrs)?.peers ?? []).map((peer) => peer.id).filter((id) => inSet.has(id)) : [],
    };
  };
  const keepWritable = (all: TwinNode[]) => (id: string) => {
    const twin = all.find((each) => each.id === id);
    return twin !== undefined && verifyAccess(cmd.access, twin.props, 'w');
  };

  return found.map((set): ReadSet => {
    const all = membersOf(set);
    const place = (twin: TwinNode) => placeOf(set, twin);
    const inSet = new Set(all.map((twin) => twin.id));
    const scoreOf = new Map(set.kind === 'near' ? set.peers.map((peer) => [peer.twin.id, peer.score] as const) : []);
    const rules = set.kind === 'exact'
      ? decideExactSet({
        original: set.original ? ruleFile(set.original, place(set.original)) : undefined,
        originalId: set.originalId,
        copies: set.copies.map((copy) => ruleFile(copy, 'inbox')),
        keepWritable: keepWritable(all),
        ...(chosen !== undefined && inSet.has(chosen) ? { chosen } : {}),
      })
      : decideNearSet({
        anchor: nearFile(set.anchor, 'inbox', inSet),
        peers: set.peers.map((peer) => ({ file: nearFile(peer.twin, place(peer.twin), inSet), score: peer.score })),
        keepWritable: keepWritable(all),
        ...(chosen !== undefined && inSet.has(chosen) ? { chosen } : {}),
      });
    // In an exact set a file with no renditions of its own shows a twin's, and its size in pixels
    // and time: the same bytes make the same picture. A copy that is not indexed (deferred) has
    // none of them.
    const shown = set.kind === 'exact' ? all.find((twin) => has(twin.id, THUMBNAILS_DIR)) : undefined;
    const dropped = new Set(rules.discard);
    const copies = new Map(set.kind === 'near' ? all.filter((twin) => dropped.has(twin.id)).map((twin) => [twin.id, copiesOf(twin)] as const) : []);
    const member = (twin: TwinNode): DuplicateMember => {
      const attrs = twin.attrs as MemberAttrs;
      const own = has(twin.id, THUMBNAILS_DIR);
      const album = albums.get(twin.id);
      const picture: MemberAttrs = own || !shown ? attrs : { ...shown.attrs as MemberAttrs, ...attrs };
      const size = displaySize(picture.width, picture.height, picture.angle);
      return {
        id: twin.id,
        path: twin.path,
        name: basename(twin.path),
        ...(typeof attrs.mimetype === 'string' ? { mimetype: attrs.mimetype } : {}),
        ...size,
        ...(typeof picture.duration === 'number' ? { duration: picture.duration } : {}),
        ...(typeof attrs.takenAt === 'string' ? { takenAt: attrs.takenAt } : {}),
        ...(typeof attrs.size === 'number' ? { size: attrs.size } : {}),
        place: place(twin),
        inScope: place(twin) === 'inbox' && inScope(scope, twin),
        previewPath: own || !shown ? twin.path : shown.path,
        thumbnails: own || shown !== undefined,
        carries: rules.carries.get(twin.id) ?? [],
        ...(album ? { album } : {}),
        ...(scoreOf.has(twin.id) ? { score: scoreOf.get(twin.id) } : {}),
        ...(typeof attrs.devicePath === 'string' ? { device: attrs.devicePath } : {}),
        copies: (copies.get(twin.id) ?? []).map((copy) => ({ id: copy.id, path: copy.path })),
      };
    };
    const staged = all.filter((twin) => place(twin) === 'inbox').sort((a, b) => (a.id === rules.keep ? -1 : b.id === rules.keep ? 1 : a.id < b.id ? -1 : 1));
    const folded = [...copies.values()].flat();
    const answer: DuplicateSet = {
      key: setKey(set.kind, set.kind === 'exact' ? set.originalId : set.anchor.id),
      kind: set.kind,
      where: set.where,
      ...(set.kind === 'exact' ? { sha256: set.sha256 } : {}),
      ...('score' in rules && typeof rules.score === 'number' ? { score: rules.score } : {}),
      keep: rules.keep,
      discard: [...rules.discard, ...folded.map((copy) => copy.id)],
      staged: staged.map(member),
      existing: all.filter((twin) => place(twin) === 'library').map(member),
      reasons: rules.reasons,
      carries: rules.gains,
      reclaimableBytes: rules.reclaimableBytes + folded.reduce((sum, copy) => sum + (typeof copy.attrs.size === 'number' ? copy.attrs.size : 0), 0),
      flags: rules.flags,
      bulk: rules.bulk,
      ...(rules.blocked ? { blocked: rules.blocked } : {}),
    };
    return { set: answer, members: [...all, ...folded] };
  });
};

/** A set read for resolving, with where a read after it goes on. */
type PlacedSet = ReadSet & { next: string };

/**
 * Up to `limit` of the scope's sets: of the classes `kind` and `where` leave, in
 * `DUPLICATE_CLASSES` order, after `cursor`. Each set says where a read goes on after it, which
 * bulk resolving stops at, and `cursor` where the next read goes on.
 */
export const readSets = async (
  cmd: Command,
  scope: DuplicateScope,
  options: { kind?: DuplicateKind; where?: DuplicateWhere; limit: number; cursor?: string },
): Promise<{ placed: PlacedSet[]; cursor: string | null }> => {
  const classes = DUPLICATE_CLASSES.filter((each) => (!options.kind || each.kind === options.kind) && (!options.where || each.where === options.where));
  const found = await findSets(cmd, scope, classes, options.cursor ? decodeCursor(options.cursor) : undefined, options.limit);
  const sets = await buildSets(cmd, scope, found.sets.map((each) => each.set));
  return {
    placed: sets.map((read, i) => ({ ...read, next: encodeCursor({ kind: found.sets[i].set.kind, where: found.sets[i].set.where, after: found.sets[i].at }) })),
    cursor: found.next ? encodeCursor(found.next) : null,
  };
};

/** One page of the scope's sets (`DuplicatePage`), as `readSets` reads them, at most `DUPLICATE_PAGE_MAX`. */
export const readDuplicatePage = async (
  cmd: Command,
  scope: DuplicateScope,
  options: { kind?: DuplicateKind; where?: DuplicateWhere; limit?: number; cursor?: string },
): Promise<DuplicatePage> => {
  const limit = options.limit ?? DUPLICATE_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > DUPLICATE_PAGE_MAX) throw new Error(`--limit is a whole number from 1 to ${DUPLICATE_PAGE_MAX}`);
  const { placed, cursor } = await readSets(cmd, scope, { ...options, limit });
  return { scope: scope.path, sets: placed.map((read) => read.set), cursor };
};

/**
 * The exact sets of the originals `originals` (by id) in the scope's inbox, read now: each original
 * by its id, then its checksum's twins. One whose original the reader cannot find, or with no copy
 * left, is not among them.
 */
const exactSetsOf = async (cmd: Command, scope: DuplicateScope, originals: string[]): Promise<FoundExact[]> => {
  const { vfs } = cmd.sys;
  if (originals.length === 0) return [];
  const nodes = await vfs.getNodesByIds(cmd.access, originals);
  const sums = new Map(originals.flatMap((id) => {
    const sha256 = (nodes.get(id)?.attrs as { sha256?: unknown } | undefined)?.sha256;
    return typeof sha256 === 'string' ? [[id, sha256] as const] : [];
  }));
  const twins = await twinsOfMany(vfs, cmd.access, [...sums.values()]);
  const found: FoundExact[] = [];
  for (const [id, sha256] of sums) {
    const among = twins.get(sha256) ?? [];
    const original = among.find((twin) => twin.id === id);
    // Where the original lies, or with it gone, where its copies last saw it.
    const named = among.map((twin) => findingOf(twin.attrs)).find((finding) => finding?.inbox === scope.user && finding.of === id);
    const where: DuplicateWhere = original ? (isLibraryPath(original.path) ? 'library' : 'inbox') : named?.where ?? 'inbox';
    const set = setAmong(scope.user, where, id, sha256, among);
    if (set.copies.length > 0) found.push(set);
  }
  return found;
};

/** The staged files `ids`, read now with their paths, as rows. */
const rowsOf = async (cmd: Command, ids: string[]): Promise<TwinNode[]> => {
  if (ids.length === 0) return [];
  const [nodes, paths] = await Promise.all([cmd.sys.vfs.getNodesByIds(cmd.access, ids), cmd.sys.vfs.resolveIdPaths(cmd.access, ids)]);
  return ids.flatMap((id) => {
    const node = nodes.get(id);
    const path = paths.get(id)?.[0];
    return node && path !== undefined ? [{ id, path, attrs: node.attrs as Record<string, unknown>, props: node.props }] : [];
  });
};

/**
 * The sets `keys` name, read now, with `chosen` kept where a set holds it. A key whose set the
 * reader cannot find, or that has nothing left to drop, is answered as undefined.
 */
export const readKeyedSets = async (cmd: Command, scope: DuplicateScope, keys: string[], chosen?: string): Promise<Map<string, ReadSet | undefined>> => {
  const parsed = keys.map(parseSetKey);
  const exact = await exactSetsOf(cmd, scope, [...new Set(parsed.filter((key) => key.kind === 'exact').map((key) => key.id))]);
  const near = await nearSetsOf(cmd, scope, await rowsOf(cmd, [...new Set(parsed.filter((key) => key.kind === 'near').map((key) => key.id))]), false);
  const sets = await buildSets(cmd, scope, [...exact, ...near], chosen);
  const byKey = new Map(sets.map((read) => [read.set.key, read]));
  return new Map(keys.map((key) => [key, byKey.get(key)]));
};

/**
 * Every set of a suggested group's members (`scope.members`), at most `GROUP_SETS_MAX`: the exact
 * set of each member that is a copy, and the near set of each member that anchors one among them.
 */
export const readGroupSets = async (cmd: Command, scope: DuplicateScope): Promise<DuplicatePage> => {
  const rows = await rowsOf(cmd, [...scope.members ?? []]);
  const originals = new Set<string>();
  const alike: TwinNode[] = [];
  for (const row of rows) {
    const finding = findingOf(row.attrs);
    if (finding?.inbox !== scope.user) continue;
    if (finding.kind === 'exact' && finding.of !== undefined) originals.add(finding.of);
    else if (finding.kind === 'near') alike.push(row);
  }
  const exact = (await exactSetsOf(cmd, scope, [...originals])).filter((set) => set.copies.some((copy) => inScope(scope, copy)));
  const near = await nearSetsOf(cmd, scope, alike, true);
  const sets = await buildSets(cmd, scope, [...exact, ...near].slice(0, GROUP_SETS_MAX));
  return { scope: scope.path, sets: sets.map((read) => read.set), cursor: null };
};

/**
 * The sets the staged files `ids` of `user`'s inbox belong to, read in the whole inbox: the exact
 * set of each that is a copy or the original of copies, and the near set of each with look-alikes.
 * Unpaged; a file with none adds none.
 */
export const readFileSets = async (cmd: Command, user: string, ids: string[]): Promise<DuplicatePage> => {
  const scope = duplicateScope(user, stagingRoots(user).filesPath);
  const rows = await rowsOf(cmd, ids);
  const originals = new Set<string>();
  const alike: TwinNode[] = [];
  for (const row of rows) {
    const finding = findingOf(row.attrs);
    if (finding?.inbox !== scope.user) continue;
    if (finding.of !== undefined) originals.add(finding.of);
    else originals.add(row.id);
    if (finding.kind === 'near') alike.push(row);
  }
  const exact = await exactSetsOf(cmd, scope, [...originals]);
  const near = await nearSetsOf(cmd, scope, alike, false);
  const sets = await buildSets(cmd, scope, [...exact, ...near]);
  return { scope: scope.path, sets: sets.map((read) => read.set), cursor: null };
};

/**
 * How many staged files the scope holds with each kind of finding, by where what they copy or look
 * like lies: one aggregate over the index, within the folder unless it is the whole inbox.
 */
export const countDuplicates = async (cmd: Command, scope: DuplicateScope): Promise<DuplicateCounts> => {
  const buckets = await cmd.sys.vfs.aggregate(cmd.access, {
    ...(scope.whole ? {} : { within: scope.path }),
    where: [{ ref: field('inbox'), op: 'eq', value: scope.user }, { ref: field('kind'), op: 'exists' }],
    group: [{ ref: field('kind') }, { ref: field('where') }],
  });
  const counts: Pick<DuplicateCounts, 'exact' | 'near'> = { exact: { library: 0, inbox: 0 }, near: { library: 0, inbox: 0 } };
  for (const bucket of buckets) {
    const [kind, where] = bucket.key as [DuplicateKind, DuplicateWhere];
    if (kind in counts && where in counts[kind]) counts[kind][where] += bucket.count;
  }
  const total = counts.exact.library + counts.exact.inbox + counts.near.library + counts.near.inbox;
  return { scope: scope.path, ...counts, total };
};
