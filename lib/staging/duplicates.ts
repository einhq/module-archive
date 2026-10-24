/**
 * Duplicate findings on staged media: the one writer of the `duplicate` attr (`DuplicateFinding`
 * in `@archive/media/api`), and of the `duplicateDecision` a person makes (`separate`).
 *
 * Every staged media original carries a finding computed for its inbox and its bytes. Among the
 * byte twins of a checksum, the original of an inbox is the smallest-id library twin its owner can
 * read, or else the smallest-id twin staged in that inbox; every other twin staged there is an
 * exact copy of it, and the original carries a marker. A copy found when it arrived is deferred,
 * not indexed (`exif-extract`), and stays so while each recomputation still finds it a copy; one
 * that stops being a copy loses `deferred`, and the bridge announces it to be indexed where it
 * lies. A finding is recomputed whole for a checksum at a time (`record`): when a file arrives
 * (`exif-extract`, `checkArrival`), when staging files or discards some (`forgetStaged`,
 * `markTrashed`, `refreshReferences`), when the bridge announces `media.duplicates.stale`
 * (`duplicates --record`, `recordPaths`), and in the hourly repair (`repairInbox`).
 *
 * The twins of many checksums are found by one `in` query over the indexed `sha256`, which the
 * store reads as an indexed lookup per checksum, and decided together, their changed findings
 * written in one batch. The decisions about one checksum are made one at a time in a process, each
 * from its lookup to its last write, so two twins checked at the same moment cannot each write what
 * the other's check has already changed.
 *
 * **Near findings.** An original with fingerprints is checked for look-alikes (`recordNear`): the
 * files whose fingerprints the index finds near its own, and those taken within seconds of it, or
 * for a recording those about as long (`@archive/staging/near-candidates`), each verified by the rules (`@archive/media/near-duplicates`)
 * and kept when it is an original in the library or staged in the same inbox, readable by the
 * inbox's owner, and not one a person separated from it. The finding lists them (`peers`), or says
 * the picture is a `hub`. A look-alike is a look-alike both ways: each staged peer that does not list
 * the file yet, and each that the file no longer lists, is checked again with it (the cascade), so
 * neither side depends on the index's approximate walk finding the other. The near part rides along
 * every exact decision about an original, and a file that becomes a copy hands its look-alikes over
 * to a recheck. A near check runs when the file's fingerprints land, when a library file's do and
 * the index finds a staged look-alike of it (the reverse check, both by `compute-fingerprint`
 * through `recordPaths`), when staging files or discards a look-alike, after a person separates
 * two files, and in the hourly repair.
 */

import type {
  ChecksumMatches,
  DuplicateDecision,
  DuplicateFinding,
  DuplicatePeer,
  DuplicateRefreshResult,
  DuplicateSeparateResult,
  DuplicatesRecorded,
  DuplicateWhere,
} from '@archive/media/api';
import { isIndexableMedia, MEDIA_EVENTS, type NodeSnapshot } from '@archive/media/event-rules';
import { matchChromaprints } from '@archive/media/chromaprint';
import { cosine, displaySize, keyframeVote, NEAR, type NearFacts, nearPictures, nearRecordings, nearVideos, rankPeers, sameShot } from '@archive/media/near-duplicates';
import { isLibraryPath } from '@archive/paths';
import { chromaprintsOf, nearCandidates, nearFilesOf, ownPrints, type PrintKind, printKindOf, recordingsLike, subSecondsOf } from '@archive/staging/near-candidates';
import { nodesAt } from '@archive/staging/nodes-at';
import { parseStagedPath, stagingRoots } from '@archive/staging/paths';
import type { AttrRef, Command, NodeProps } from '@ein/client';
import { accessOfUser, EVENTS_NODE_PATH, NOT_DERIVED } from '@ein/client';
import { HOMES_PATH, isTrashPath } from '@ein/paths';
import { ulid } from '@std/ulid';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The attr a finding is kept in. */
export const DUPLICATE_ATTR = 'duplicate';

/** The attr a person's decision about a file's look-alikes is kept in. */
const DECISION_ATTR = 'duplicateDecision';

const field = (name: keyof DuplicateFinding): AttrRef => ({ path: [DUPLICATE_ATTR, name] });

/** Rows per page of twins, of a subtree's files, and ids per chunk of the repair. */
const PAGE = 1_000;

/** Checksums one lookup takes, and one decision decides together. */
const CHECKSUMS_AT_ONCE = 500;

/** How long an inbox owner's access is reused. */
const OWNER_ACCESS_MS = 60_000;

/** Levels a trashed file lies below `/home`: `<user>/.trash/<batch>/<entry>/<name>`, with room. */
const TRASH_DEPTH = 8;

/** One file a finding is about: its id, where it is, and its attrs. */
type Twin = { id: string; path: string; attrs: Record<string, unknown> };

/** A byte twin as a lookup reads it: a `Twin` with its node's props. */
export type TwinNode = Twin & { props: NodeProps };

/** The owner of the staging inbox `path` lies in (anywhere under its `files/`), or undefined. */
export const inboxOf = (path: string | undefined): string | undefined => {
  if (path === undefined) return undefined;
  const parsed = parseStagedPath(path);
  return parsed?.area === 'files' && parsed.category !== undefined ? parsed.user : undefined;
};

/** The finding in `attrs`, or undefined when there is none. */
export const findingOf = (attrs: Record<string, unknown>): DuplicateFinding | undefined => {
  const value = attrs[DUPLICATE_ATTR];
  return value && typeof value === 'object' && typeof (value as DuplicateFinding).sha256 === 'string' ? value as DuplicateFinding : undefined;
};

const samePeers = (a: DuplicatePeer[] | undefined, b: DuplicatePeer[] | undefined): boolean =>
  (a?.length ?? 0) === (b?.length ?? 0) &&
  (a ?? []).every((peer, i) => peer.id === b![i].id && peer.method === b![i].method && peer.score === b![i].score);

/** Whether two findings say the same, whenever each was computed. */
export const sameFinding = (a: DuplicateFinding | undefined, b: DuplicateFinding | undefined): boolean =>
  a?.inbox === b?.inbox && a?.sha256 === b?.sha256 && a?.kind === b?.kind && a?.where === b?.where && a?.of === b?.of &&
  (a?.deferred === true) === (b?.deferred === true) && a?.hub === b?.hub && samePeers(a?.peers, b?.peers);

/** The ids a staged file's decision separates it from. */
export const separatedFrom = (attrs: Record<string, unknown>): string[] => {
  const separate = (attrs[DECISION_ATTR] as DuplicateDecision | undefined)?.separate;
  return Array.isArray(separate) ? separate.filter((id): id is string => typeof id === 'string') : [];
};

/**
 * What an original's finding says of its look-alikes, when it was computed for `user`'s inbox and
 * `sha256`: carried over by an exact decision, which says nothing about them.
 */
const nearPart = (finding: DuplicateFinding | undefined, user: string, sha256: string): Pick<DuplicateFinding, 'kind' | 'where' | 'peers' | 'hub'> => {
  if (!finding || finding.inbox !== user || finding.sha256 !== sha256 || finding.of !== undefined) return {};
  if (finding.kind === 'near' && finding.peers && finding.peers.length > 0) return { kind: 'near', where: finding.where ?? 'inbox', peers: finding.peers };
  return finding.hub ? { hub: finding.hub } : {};
};

/** The staged look-alikes a finding lists. */
const peerIds = (finding: DuplicateFinding | undefined): string[] => finding?.kind === 'near' ? (finding.peers ?? []).map((peer) => peer.id) : [];

/** `finding` for a file that is indexed: without `deferred`. */
export const undeferred = (finding: DuplicateFinding): DuplicateFinding => {
  const { deferred: _deferred, ...rest } = finding;
  return rest;
};

/** Whether `attrs` are a deferred copy's: an exact copy not indexed while it is one. */
export const isDeferred = (attrs: Record<string, unknown>): boolean => findingOf(attrs)?.deferred === true;

/**
 * What a finding becomes when its file goes to a trash: in no inbox, so in no inbox's findings. A
 * deferred copy stays deferred, so one restored is decided again before anything indexes it.
 */
const trashedForm = (finding: DuplicateFinding): DuplicateFinding => ({
  sha256: finding.sha256,
  at: finding.at,
  ...(finding.of !== undefined ? { of: finding.of } : {}),
  ...(finding.deferred ? { deferred: true as const } : {}),
});

const snapshot = (twin: Twin, type = 'file'): NodeSnapshot => ({ id: twin.id, type, attrs: twin.attrs });

const checksumOf = (attrs: Record<string, unknown>): string | undefined => typeof attrs.sha256 === 'string' && attrs.sha256 !== '' ? attrs.sha256 : undefined;

const timestamp = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** `items` in chunks of `size`. */
const chunked = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Per checksum, the end of the last decision about it queued in this process. */
const checksumQueue = new Map<string, Promise<void>>();

/**
 * Run `fn` once every decision about any of `sha256s` queued before it in this process is done.
 * A caller takes its place behind all of its checksums at once, so two callers sharing some can
 * never each wait for the other.
 */
const withChecksums = async <T>(sha256s: string[], fn: () => Promise<T>): Promise<T> => {
  const unique = [...new Set(sha256s)];
  const befores = unique.map((sha256) => checksumQueue.get(sha256) ?? Promise.resolve());
  let release!: () => void;
  const done = new Promise<void>((resolve) => release = resolve);
  const tails = unique.map((sha256, i) => {
    const tail = befores[i].then(() => done);
    checksumQueue.set(sha256, tail);
    return tail;
  });
  await Promise.all(befores);
  try {
    return await fn();
  } finally {
    release();
    unique.forEach((sha256, i) => {
      if (checksumQueue.get(sha256) === tails[i]) checksumQueue.delete(sha256);
    });
  }
};

const ownerAccesses = new Map<string, { access: Access; until: number }>();

/**
 * The access of `user`, the owner of an inbox, which decides which library files count for it:
 * the caller's own when the caller owns the inbox's home, otherwise the account's, reused for a
 * minute. Undefined for a user with no home or no account.
 */
const ownerAccess = async (cmd: Command, user: string): Promise<Access | undefined> => {
  const home = await cmd.sys.vfs.get(cmd.access, stagingRoots(user).homePath).catch(() => undefined);
  if (!home) return undefined;
  if (home.props.uid === cmd.access.uid) return cmd.access;
  const cached = ownerAccesses.get(user);
  if (cached && cached.until > Date.now()) return cached.access;
  const access = await accessOfUser(cmd.sys.vfs, cmd.access, user).catch(() => undefined);
  if (access) ownerAccesses.set(user, { access, until: Date.now() + OWNER_ACCESS_MS });
  return access;
};

/**
 * For each of `sha256s`, the media originals carrying it that `access` reads, outside every trash
 * (none for a checksum nothing carries): one query a page of rows at a time, for up to
 * `CHECKSUMS_AT_ONCE` checksums.
 */
export const twinsOfMany = async (vfs: Vfs, access: Access, sha256s: Iterable<string>): Promise<Map<string, TwinNode[]>> => {
  const unique = [...new Set(sha256s)];
  const found = new Map<string, TwinNode[]>(unique.map((sha256) => [sha256, []]));
  for (const chunk of chunked(unique, CHECKSUMS_AT_ONCE)) {
    let after: { value: string | null; id: string } | undefined;
    for (;;) {
      const rows = await vfs.query(access, {
        types: ['file'],
        where: [{ ref: 'sha256', op: 'in', value: chunk }, NOT_DERIVED],
        ...(after ? { after } : {}),
        limit: PAGE,
      });
      for (const row of rows) {
        const twin = { id: row.id, path: row.absPath, attrs: row.node.attrs as Record<string, unknown>, props: row.node.props };
        const sha256 = checksumOf(twin.attrs);
        if (sha256 !== undefined && isIndexableMedia(snapshot(twin, row.node.type))) found.get(sha256)?.push(twin);
      }
      if (rows.length < PAGE) break;
      after = { value: null, id: rows[rows.length - 1].id };
    }
  }
  return found;
};

/** What to decide about one checksum, and for whom. */
type Decision = {
  sha256: string;
  /** Only twins staged in these inboxes are decided; twins in every inbox when absent. */
  inboxes?: ReadonlySet<string>;
  /** A twin the lookup may not see yet (its checksum is being written with the finding). */
  subject?: Twin;
  /** The twin whose finding is answered rather than written: its caller writes it. */
  hold?: string;
};

/** What deciding a checksum wrote, the held twin's finding, and the look-alikes of twins that became copies. */
type Recorded = { written: string[]; held?: DuplicateFinding; handedOver: string[] };

/**
 * Decide the findings of the staged twins of each checksum in `decisions` (those in its
 * `inboxes`), and write each that changed: `CHECKSUMS_AT_ONCE` checksums at a time, each in its
 * turn (`withChecksums`). Answers what was written per checksum.
 */
const record = async (cmd: Command, decisions: Decision[]): Promise<Map<string, Recorded>> => {
  const done = new Map<string, Recorded>();
  for (const chunk of chunked(decisions, CHECKSUMS_AT_ONCE)) {
    const recorded = await withChecksums(chunk.map((decision) => decision.sha256), () => decide(cmd, chunk));
    for (const [sha256, outcome] of recorded) done.set(sha256, outcome);
  }
  await recordNear(cmd, [...done.values()].flatMap((outcome) => outcome.handedOver), { cascade: false });
  return done;
};

/** `record` for each of `sha256s` alike, in `inboxes` when given. */
const recordAll = (cmd: Command, sha256s: Iterable<string>, inboxes?: ReadonlySet<string>): Promise<Map<string, Recorded>> =>
  record(cmd, [...new Set(sha256s)].map((sha256) => ({ sha256, ...(inboxes ? { inboxes } : {}) })));

/**
 * `record` of one chunk without waiting its turn: one lookup of every checksum's twins, per inbox
 * owner one read of which of their library twins the owner can reach and read (an owner with no
 * account can read none), and one batch of writes.
 */
const decide = async (cmd: Command, decisions: Decision[]): Promise<Map<string, Recorded>> => {
  const { vfs } = cmd.sys;
  const found = await twinsOfMany(vfs, cmd.access, decisions.map((decision) => decision.sha256));

  /** Per checksum, its library twins and its twins staged in each inbox decided. */
  const work = decisions.map((decision) => {
    const twins: Twin[] = [...found.get(decision.sha256) ?? []];
    if (decision.subject && !twins.some((twin) => twin.id === decision.subject!.id)) twins.push(decision.subject);
    const library = twins.filter((twin) => isLibraryPath(twin.path)).map((twin) => twin.id);
    const staged = new Map<string, Twin[]>();
    for (const twin of twins) {
      const user = inboxOf(twin.path);
      if (user === undefined || (decision.inboxes && !decision.inboxes.has(user))) continue;
      staged.set(user, [...staged.get(user) ?? [], twin]);
    }
    return { decision, library, staged };
  });

  /** Per inbox owner, the library twins they read. */
  const libraryOf = new Map<string, Set<string>>();
  for (const { library, staged } of work) {
    if (library.length === 0) continue;
    for (const user of staged.keys()) libraryOf.set(user, new Set([...libraryOf.get(user) ?? [], ...library]));
  }
  const readable = new Map<string, Set<string>>();
  for (const [user, ids] of libraryOf) {
    const access = await ownerAccess(cmd, user);
    readable.set(user, access === undefined ? new Set() : new Set((await vfs.getNodesByIds(access, [...ids])).keys()));
  }

  const at = timestamp();
  const done = new Map<string, Recorded>();
  const changes: { ref: string; attrs: Record<string, unknown>; sha256: string }[] = [];
  for (const { decision: { sha256, hold }, library, staged } of work) {
    const recorded: Recorded = { written: [], handedOver: [] };
    done.set(sha256, recorded);
    for (const [user, members] of staged) {
      const read = library.filter((id) => readable.get(user)?.has(id));
      const smallest = (ids: string[]) => ids.reduce((a, b) => (b < a ? b : a));
      const original: { id: string; where: DuplicateWhere } = read.length > 0
        ? { id: smallest(read), where: 'library' }
        : { id: smallest(members.map((twin) => twin.id)), where: 'inbox' };
      for (const twin of members) {
        // A copy that was deferred stays so while it is a copy; an original never is. An original
        // keeps what its near check found; a copy has look-alikes only through its original.
        const current = findingOf(twin.attrs);
        const desired: DuplicateFinding = twin.id === original.id
          ? { inbox: user, sha256, at, ...nearPart(current, user, sha256) }
          : { inbox: user, sha256, at, kind: 'exact', where: original.where, of: original.id, ...(isDeferred(twin.attrs) ? { deferred: true as const } : {}) };
        if (twin.id !== original.id) recorded.handedOver.push(...peerIds(current));
        if (twin.id === hold) recorded.held = desired;
        else if (!sameFinding(findingOf(twin.attrs), desired)) changes.push({ ref: twin.path, attrs: { [DUPLICATE_ATTR]: desired }, sha256 });
      }
    }
  }

  const settled = changes.length === 0 ? [] : await vfs.updateEach(cmd.access, changes.map(({ ref, attrs }) => ({ ref, attrs })));
  const refused = settled.find((outcome) => outcome.status === 'rejected');
  if (refused) throw refused.reason;
  changes.forEach((change) => done.get(change.sha256)!.written.push(change.ref));
  return done;
};

/**
 * The duplicate check of a file `exif-extract` reads, at `path`: `write` is handed what the file's
 * finding is to be, and makes its update of the file while no other decision about the file's
 * checksum is made. A staged media original with a checksum gets a marker or an exact copy (its
 * twins in the inbox decided and written here), which `write` compares with what the file carries
 * (`sameFinding`); a file no longer staged that still carries a finding gets `null`, and anything
 * else undefined. A check that fails hands `write` undefined and throws once it has written.
 */
export const checkArrival = async (cmd: Command, path: string, file: Twin, write: (finding: DuplicateFinding | null | undefined) => Promise<void>): Promise<void> => {
  const user = inboxOf(path);
  const sha256 = checksumOf(file.attrs);
  if (user === undefined || sha256 === undefined || !isIndexableMedia(snapshot(file))) {
    return await write(user === undefined && file.attrs[DUPLICATE_ATTR] !== undefined ? null : undefined);
  }
  const handedOver: string[] = [];
  await withChecksums([sha256], async () => {
    let finding: DuplicateFinding | undefined;
    let failure: unknown;
    try {
      const recorded = (await decide(cmd, [{ sha256, inboxes: new Set([user]), subject: { ...file, path }, hold: file.id }])).get(sha256)!;
      finding = recorded.held;
      handedOver.push(...recorded.handedOver);
    } catch (error) {
      failure = error;
    }
    await write(finding);
    if (failure !== undefined) throw failure;
  });
  await recordNear(cmd, handedOver, { cascade: false });
};

/** Staged files that moved, by id and where they are now. */
type MovedFile = { id: string; from: string; to: string };

/**
 * Bring findings up to date after staged files were filed into the library: each loses its own
 * finding, the twins left in its inbox are decided again, so a copy of a filed file reads as a
 * copy of a library file, and its look-alikes left there are checked again, so they read as
 * look-alikes of a library file. Other inboxes' are the bridge's to announce.
 */
export const forgetStaged = async (cmd: Command, moved: MovedFile[]): Promise<void> => {
  if (moved.length === 0) return;
  const { vfs } = cmd.sys;
  const nodes = await vfs.getNodesByIds(cmd.access, moved.map((move) => move.id));
  const clear = moved.filter((move) => nodes.get(move.id)?.attrs[DUPLICATE_ATTR] !== undefined).map((move) => move.to);
  if (clear.length > 0) {
    const refused = (await vfs.updateMany(cmd.access, clear, { attrs: { [DUPLICATE_ATTR]: null } })).find((outcome) => outcome.status === 'rejected');
    if (refused) throw refused.reason;
  }

  const byInbox = new Map<string, Set<string>>();
  for (const move of moved) {
    const node = nodes.get(move.id);
    const user = inboxOf(move.from);
    const sha256 = node && checksumOf(node.attrs);
    if (!node || user === undefined || sha256 === undefined || !isIndexableMedia({ id: move.id, type: node.type, attrs: node.attrs })) continue;
    byInbox.set(user, (byInbox.get(user) ?? new Set()).add(sha256));
  }
  for (const [user, sha256s] of byInbox) await recordAll(cmd, sha256s, new Set([user]));

  const extra = new Map<string, string[]>();
  for (const move of moved) {
    const node = nodes.get(move.id);
    for (const peer of peerIds(node && findingOf(node.attrs as Record<string, unknown>))) extra.set(peer, [...extra.get(peer) ?? [], move.id]);
  }
  await recordNear(cmd, [...extra.keys()], { extra, cascade: false });
};

/** The files with a finding in `user`'s inbox within `dir`. */
const findingsWithin = async (vfs: Vfs, access: Access, dir: string, user: string): Promise<Twin[]> => {
  const found: Twin[] = [];
  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const rows = await vfs.query(access, {
      within: dir,
      types: ['file'],
      where: [{ ref: field('inbox'), op: 'eq', value: user }],
      ...(after ? { after } : {}),
      limit: PAGE,
    });
    found.push(...rows.map((row) => ({ id: row.id, path: row.absPath, attrs: row.node.attrs as Record<string, unknown> })));
    if (rows.length < PAGE) return found;
    after = { value: null, id: rows[rows.length - 1].id };
  }
};

/**
 * Before staged files go to a trash: give `files` (staged files as read) and the files within
 * `dirs` the trashed form of their finding, so none stays in `user`'s findings while it is
 * trashed. Answers the checksums of the originals among them, whose copies `refreshReferences`
 * decides again once they are gone, and of all of them, for when some never went; and their
 * look-alikes, which `refreshReferences` checks again, and the files marked, which it checks again
 * too when some never went.
 */
export const markTrashed = async (
  cmd: Command,
  user: string,
  files: Twin[],
  dirs: string[],
): Promise<{ originals: string[]; all: string[]; peers: string[]; ids: string[] }> => {
  const { vfs } = cmd.sys;
  const marked = files.filter((file) => findingOf(file.attrs)?.inbox === user);
  for (const dir of dirs) marked.push(...await findingsWithin(vfs, cmd.access, dir, user));

  const originals = new Set<string>();
  const all = new Set<string>();
  const peers = new Set<string>();
  const changes = marked.map((file) => {
    const finding = findingOf(file.attrs)!;
    all.add(finding.sha256);
    for (const peer of peerIds(finding)) peers.add(peer);
    if (finding.of === undefined) originals.add(finding.sha256);
    return { ref: file.path, attrs: { [DUPLICATE_ATTR]: trashedForm(finding) } };
  });
  if (changes.length > 0) {
    const refused = (await vfs.updateEach(cmd.access, changes)).find((outcome) => outcome.status === 'rejected');
    if (refused) throw refused.reason;
  }
  const gone = new Set(marked.map((file) => file.id));
  return { originals: [...originals], all: [...all], peers: [...peers].filter((id) => !gone.has(id)), ids: [...gone] };
};

/**
 * After originals left `user`'s inbox for a trash: decide their checksums' twins there again, so a
 * copy of one names the next original, or becomes one, and check their look-alikes `peers` again,
 * so none names a file in the trash. Files marked trashed that are still staged get their findings
 * back the same way.
 */
export const refreshReferences = async (cmd: Command, user: string, sha256s: string[], peers: string[] = []): Promise<void> => {
  await recordAll(cmd, sha256s, new Set([user]));
  await recordNear(cmd, peers, { cascade: false });
};

/**
 * `duplicates --record`: the findings involving `paths` and the files within the directories
 * among them, decided again. A staged file's own inbox is decided for its checksum, and the file
 * checked for look-alikes; a library file's checksum is decided in every inbox, and the staged
 * files the index finds alike to it checked with it (the reverse check); a file elsewhere loses a
 * finding it still carries.
 */
export const recordPaths = async (cmd: Command, paths: string[]): Promise<DuplicatesRecorded> => {
  const { vfs } = cmd.sys;
  const answer: DuplicatesRecorded = { ok: true, recorded: 0, unchanged: 0, skipped: [] };
  const files: (Twin & { named: boolean })[] = [];
  const found = await nodesAt(vfs, cmd.access, paths);
  for (const path of paths) {
    const node = found.get(path);
    if (!node) answer.skipped.push({ path, reason: 'not found' });
    else if (node.type === 'file') files.push({ id: node.id, path, attrs: node.attrs as Record<string, unknown>, named: true });
    else if (node.type === 'directory') {
      let after: { value: string | null; id: string } | undefined;
      for (;;) {
        const rows = await vfs.query(cmd.access, { within: path, types: ['file'], where: [NOT_DERIVED], ...(after ? { after } : {}), limit: PAGE });
        files.push(...rows.map((row) => ({ id: row.id, path: row.absPath, attrs: row.node.attrs as Record<string, unknown>, named: false })));
        if (rows.length < PAGE) break;
        after = { value: null, id: rows[rows.length - 1].id };
      }
    } else answer.skipped.push({ path, reason: `a ${node.type}, not a file or a directory` });
  }

  /** Per checksum, the inboxes to decide: undefined for every one. */
  const work = new Map<string, Set<string> | undefined>();
  const claims: { sha256: string; path: string }[] = [];
  const clear: string[] = [];
  for (const file of files) {
    const sha256 = checksumOf(file.attrs);
    const user = inboxOf(file.path);
    if (!isIndexableMedia(snapshot(file))) {
      if (file.named) answer.skipped.push({ path: file.path, reason: 'not a media original' });
      continue;
    }
    if (user === undefined && !isLibraryPath(file.path)) {
      if (file.attrs[DUPLICATE_ATTR] !== undefined) clear.push(file.path);
      else answer.unchanged++;
      continue;
    }
    if (sha256 === undefined) {
      answer.skipped.push({ path: file.path, reason: 'no checksum yet' });
      continue;
    }
    if (user === undefined && file.attrs[DUPLICATE_ATTR] !== undefined) clear.push(file.path);
    if (user === undefined) work.set(sha256, undefined);
    else if (!work.has(sha256) || work.get(sha256) !== undefined) work.set(sha256, (work.get(sha256) ?? new Set()).add(user));
    claims.push({ sha256, path: file.path });
  }

  if (clear.length > 0) {
    const refused = (await vfs.updateMany(cmd.access, clear, { attrs: { [DUPLICATE_ATTR]: null } })).find((outcome) => outcome.status === 'rejected');
    if (refused) throw refused.reason;
    answer.recorded += clear.length;
  }
  const cleared = new Set(clear);
  const done = await record(cmd, [...work].map(([sha256, inboxes]) => ({ sha256, ...(inboxes ? { inboxes } : {}) })));

  // Look-alikes: each staged file's own, and the staged ones of each library file.
  const near: string[] = [];
  const extra = new Map<string, string[]>();
  for (const file of files) {
    if (!isIndexableMedia(snapshot(file)) || checksumOf(file.attrs) === undefined) continue;
    if (inboxOf(file.path) !== undefined) near.push(file.id);
    else if (isLibraryPath(file.path)) {
      const kind = printKindOf(file.attrs.mimetype);
      if (!kind) continue;
      const alike = await nearFilesOf(vfs, cmd.access, file.id, kind);
      const paths = alike.length > 0 ? await vfs.resolveIdPaths(cmd.access, alike) : new Map<string, string[]>();
      for (const [id, at] of paths) {
        if (at.some((path) => inboxOf(path) !== undefined)) extra.set(id, [...extra.get(id) ?? [], file.id]);
      }
    }
  }
  const nearWritten = new Set<string>();
  const byId = new Map(files.map((file) => [file.id, file.path] as const));
  for (const written of await recordNear(cmd, [...new Set([...near, ...extra.keys()])], { extra })) {
    nearWritten.add(written.path);
    // A library file's recheck wrote when one of its staged look-alikes' findings changed.
    for (const library of extra.get(written.id) ?? []) if (byId.has(library)) nearWritten.add(byId.get(library)!);
  }

  for (const claim of claims) {
    if (cleared.has(claim.path)) continue;
    if (done.get(claim.sha256)!.written.length > 0 || nearWritten.has(claim.path)) answer.recorded++;
    else answer.unchanged++;
  }
  return answer;
};

/**
 * `duplicates --checksum`: for each of `sha256s`, the media originals carrying it that the caller
 * reads in the library or in `user`'s own inbox.
 */
export const checksumMatches = async (cmd: Command, user: string, sha256s: string[]): Promise<ChecksumMatches> => {
  const matches: ChecksumMatches['matches'] = [];
  const found = await twinsOfMany(cmd.sys.vfs, cmd.access, sha256s);
  for (const sha256 of sha256s) {
    for (const twin of found.get(sha256) ?? []) {
      const where: DuplicateWhere | undefined = isLibraryPath(twin.path) ? 'library' : inboxOf(twin.path) === user ? 'inbox' : undefined;
      if (where !== undefined) matches.push({ sha256, where, path: twin.path });
    }
  }
  return { matches: matches.sort((a, b) => a.sha256.localeCompare(b.sha256) || a.path.localeCompare(b.path)) };
};

/** Whether a picture, video or recording was fingerprinted, which a near check compares. */
const hasPrints = (attrs: Record<string, unknown>): boolean => printKindOf(attrs.mimetype) !== undefined && typeof attrs.fingerprintedAt === 'string';

/**
 * Whether a staged media file's finding was computed for inbox `user`, the bytes it has now, and,
 * for an original, after its fingerprints landed.
 */
const holds = (attrs: Record<string, unknown>, user: string): boolean => {
  const finding = findingOf(attrs);
  if (finding?.inbox !== user || finding.sha256 !== attrs.sha256) return false;
  return finding.of !== undefined || !hasPrints(attrs) || String(attrs.fingerprintedAt) <= finding.at;
};

/**
 * `staging duplicates --refresh`: announce `media.duplicates.stale` for each media original
 * within `scope` (in `user`'s inbox) whose finding does not hold, or for every one with `force`,
 * at most `limit` of them, after the file `cursor` names. With `dryRun` they are counted only.
 */
export const refreshScope = async (
  cmd: Command,
  user: string,
  scope: string,
  options: { force: boolean; limit: number; cursor?: string; dryRun: boolean },
): Promise<DuplicateRefreshResult> => {
  const { vfs } = cmd.sys;
  const answer: DuplicateRefreshResult = { ok: true, examined: 0, emitted: 0, withPrints: 0, complete: false, cursor: null, dryRun: options.dryRun };
  const events = options.dryRun ? undefined : await vfs.open(cmd.access, EVENTS_NODE_PATH, { mode: 'a' });
  const encoder = new TextEncoder();
  try {
    let after: { value: string | null; id: string } | undefined = options.cursor ? { value: null, id: options.cursor } : undefined;
    /** The last file handled, after which the next call goes on. */
    let handled = options.cursor;
    for (;;) {
      const rows = await vfs.query(cmd.access, { within: scope, types: ['file'], where: [NOT_DERIVED], ...(after ? { after } : {}), limit: PAGE });
      for (const row of rows) {
        const attrs = row.node.attrs as Record<string, unknown>;
        const due = isIndexableMedia({ id: row.id, type: row.node.type, attrs }) && checksumOf(attrs) !== undefined;
        if (due && (options.force || !holds(attrs, user))) {
          if (answer.emitted === options.limit) {
            answer.cursor = handled ?? null;
            return answer;
          }
          const fact = {
            id: ulid(),
            type: MEDIA_EVENTS.duplicatesStale,
            subject: row.absPath,
            nodeId: row.id,
            time: Date.now(),
            source: 'staging duplicates',
            data: { cause: 'refresh', sha256: String(attrs.sha256) },
          };
          if (events) await events.write(encoder.encode(`${JSON.stringify(fact)}\n`));
          answer.emitted++;
        }
        if (due) answer.examined++;
        if (due && hasPrints(attrs)) answer.withPrints++;
        handled = row.id;
      }
      if (rows.length < PAGE) {
        answer.complete = true;
        return answer;
      }
      after = { value: null, id: rows[rows.length - 1].id };
    }
  } finally {
    await events?.close();
  }
};

/**
 * The paths of `ids` that no path resolution names, because they lie in a trash: each walked up
 * by its parent links to `/home`. Ids that do not end there are absent.
 */
const trashedPaths = async (vfs: Vfs, access: Access, ids: string[]): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  if (ids.length === 0) return found;
  const homes = (await vfs.get(access, HOMES_PATH)).id;
  let climbing = new Map(ids.map((id) => [id, { at: id, names: [] as string[] }]));
  for (let level = 0; climbing.size > 0 && level < TRASH_DEPTH; level++) {
    const links = await vfs.getParentLinksByIds(access, [...new Set([...climbing.values()].map((walk) => walk.at))]);
    const next = new Map<string, { at: string; names: string[] }>();
    for (const [id, walk] of climbing) {
      const link = links.get(walk.at)?.[0];
      if (!link) continue;
      const names = [link.name, ...walk.names];
      if (link.parentId === homes) {
        const path = `${HOMES_PATH}/${names.join('/')}`;
        if (isTrashPath(path)) found.set(id, path);
      } else next.set(id, { at: link.parentId, names });
    }
    climbing = next;
  }
  return found;
};

/** What `repairInbox` found and did. */
type InboxRepair = { examined: number; cleared: number; trashed: number; recomputed: number };

/**
 * Check every finding of `user`'s inbox against where its file is now: a file in a trash gets the
 * trashed form, one staged in another inbox is decided there, one anywhere else loses its finding,
 * a copy whose bytes changed, or whose original is gone, unreadable to the owner, other bytes
 * now or no longer where `where` says, is decided again, and a look-alike's file whose look-alikes
 * are not all in the library or the inbox any more is checked again. A thousand findings at a time, with one
 * read of their nodes, their paths and their originals each.
 */
export const repairInbox = async (cmd: Command, user: string): Promise<InboxRepair> => {
  const { vfs } = cmd.sys;
  const repair: InboxRepair = { examined: 0, cleared: 0, trashed: 0, recomputed: 0 };
  const buckets = await vfs.aggregate(cmd.access, {
    types: ['file'],
    where: [{ ref: field('inbox'), op: 'eq', value: user }, { ref: field('kind'), op: 'exists' }],
    group: [{ column: 'id' }],
  });
  const ids = buckets.map((bucket) => bucket.key[0]);
  const owner = ids.length > 0 ? await ownerAccess(cmd, user) : undefined;

  for (let start = 0; start < ids.length; start += PAGE) {
    const chunk = ids.slice(start, start + PAGE);
    const nodes = await vfs.getNodesByIds(cmd.access, chunk);
    const paths = await vfs.resolveIdPaths(cmd.access, chunk);
    const hidden = await trashedPaths(vfs, cmd.access, chunk.filter((id) => nodes.has(id) && !paths.has(id)));

    const recompute = new Map<string, Set<string>>();
    const again = (sha256: string, inbox: string) => recompute.set(sha256, (recompute.get(sha256) ?? new Set()).add(inbox));
    const clear: string[] = [];
    const trash: { ref: string; attrs: Record<string, unknown> }[] = [];
    const copies: { id: string; sha256: string; finding: DuplicateFinding }[] = [];
    const alike: { id: string; finding: DuplicateFinding }[] = [];
    for (const id of chunk) {
      const node = nodes.get(id);
      const finding = node && findingOf(node.attrs as Record<string, unknown>);
      if (!node || !finding) continue;
      repair.examined++;
      const path = paths.get(id)?.[0];
      const sha256 = checksumOf(node.attrs as Record<string, unknown>);
      if (path === undefined) {
        const trashed = hidden.get(id);
        if (trashed !== undefined) trash.push({ ref: trashed, attrs: { [DUPLICATE_ATTR]: trashedForm(finding) } });
      } else if (inboxOf(path) === undefined) clear.push(path);
      else if (sha256 === undefined) clear.push(path);
      else if (inboxOf(path) !== user || sha256 !== finding.sha256) again(sha256, inboxOf(path)!);
      else if (finding.of !== undefined) copies.push({ id, sha256, finding });
      else if (finding.kind === 'near') alike.push({ id, finding });
    }

    if (copies.length > 0) {
      const ofs = [...new Set(copies.map((copy) => copy.finding.of!))];
      const seen = await vfs.resolveIdPaths(cmd.access, ofs);
      const originals = owner ? await vfs.getNodesByIds(owner, ofs) : new Map();
      for (const { sha256, finding } of copies) {
        const at = seen.get(finding.of!)?.[0];
        const original = originals.get(finding.of!);
        const there = at !== undefined && (finding.where === 'library' ? isLibraryPath(at) : inboxOf(at) === user);
        if (!there || !original || checksumOf(original.attrs as Record<string, unknown>) !== sha256) again(sha256, user);
      }
    }

    if (clear.length > 0) {
      const refused = (await vfs.updateMany(cmd.access, clear, { attrs: { [DUPLICATE_ATTR]: null } })).find((outcome) => outcome.status === 'rejected');
      if (refused) throw refused.reason;
      repair.cleared += clear.length;
    }
    if (trash.length > 0) {
      const refused = (await vfs.updateEach(cmd.access, trash)).find((outcome) => outcome.status === 'rejected');
      if (refused) throw refused.reason;
      repair.trashed += trash.length;
    }
    await record(cmd, [...recompute].map(([sha256, inboxes]) => ({ sha256, inboxes })));
    repair.recomputed += recompute.size;

    // A look-alike gone, or no longer in the library or the inbox, is checked again.
    if (alike.length > 0) {
      const seen = await vfs.resolveIdPaths(cmd.access, [...new Set(alike.flatMap(({ finding }) => peerIds(finding)))]);
      const stale = alike.filter(({ finding }) => peerIds(finding).some((peer) => !(seen.get(peer) ?? []).some((path) => isLibraryPath(path) || inboxOf(path) === user)));
      await recordNear(cmd, stale.map(({ id }) => id));
      repair.recomputed += stale.length;
    }
  }
  return repair;
};

/** A file a near check wrote the finding of, by id and path. */
type NearWritten = { id: string; path: string };

/** What one file's near check found: what it wrote, and the staged files to check again with it. */
type NearOutcome = { written?: NearWritten; joined: string[]; left: string[] };

/** A candidate as the rules read it: its node, its path, and how alike it is. */
type Seen = { id: string; path: string; attrs: Record<string, unknown>; score: number; facts: NearFacts };

const factsOf = (id: string, attrs: Record<string, unknown>): NearFacts => {
  const size = displaySize(attrs.width, attrs.height, attrs.angle);
  return {
    id,
    ...(typeof attrs.mimetype === 'string' ? { mimetype: attrs.mimetype } : {}),
    ...size,
    ...(typeof attrs.takenAtUtc === 'string' ? { takenAtUtc: attrs.takenAtUtc } : {}),
    ...(typeof attrs.takenAtSource === 'string' ? { takenAtSource: attrs.takenAtSource } : {}),
    ...(typeof attrs.devicePath === 'string' ? { device: attrs.devicePath } : {}),
    ...(typeof attrs.duration === 'number' ? { duration: attrs.duration } : {}),
  };
};

const roundScore = (score: number): number => Math.round(score * 1000) / 1000;

/** How a look-alike of each kind of file is found alike. */
const METHODS: Record<PrintKind, DuplicatePeer['method']> = { image: 'sscd', video: 'keyframes', audio: 'chromaprint' };

/**
 * The near check of the staged file `id`: its look-alikes found and verified, and its finding
 * written when that changed, under its checksum's turn (`withChecksums`) and only while the file is
 * still the original these bytes were decided for in its inbox. Nothing is checked for a file that
 * is not a staged media original with a finding for its bytes (its exact check comes first), or
 * whose inbox's owner has no account. A file without fingerprints yet keeps no look-alikes.
 */
const nearOne = async (cmd: Command, id: string, extra: string[]): Promise<NearOutcome | undefined> => {
  const { vfs } = cmd.sys;
  const [node, paths] = await Promise.all([vfs.getNodesByIds(cmd.access, [id]).then((found) => found.get(id)), vfs.resolveIdPaths(cmd.access, [id])]);
  const path = paths.get(id)?.[0];
  if (!node || path === undefined) return undefined;
  const attrs = node.attrs as Record<string, unknown>;
  const user = inboxOf(path);
  const sha256 = checksumOf(attrs);
  const finding = findingOf(attrs);
  const kind = printKindOf(attrs.mimetype);
  if (user === undefined || sha256 === undefined || !kind || !isIndexableMedia({ id, type: node.type, attrs })) return undefined;
  if (!finding || finding.inbox !== user || finding.sha256 !== sha256 || finding.of !== undefined) return undefined;
  const owner = await ownerAccess(cmd, user);
  if (!owner) return undefined;

  const self = factsOf(id, attrs);
  const own = kind === 'audio' ? undefined : await ownPrints(vfs, cmd.access, id, kind);
  const ownSound = kind === 'audio' ? (await chromaprintsOf(vfs, cmd.access, [{ id, path }])).get(id) : undefined;
  const printed = own !== undefined || ownSound !== undefined;
  let peers: DuplicatePeer[] = [];
  let hub = false;
  let where: DuplicateWhere = 'inbox';
  /** The staged look-alikes kept, with what their own findings say. */
  const stagedPeers = new Map<string, DuplicateFinding | undefined>();
  if (printed) {
    /** Each candidate, with a picture's or video's prints; a recording's are read once it passed the rules of place. */
    const candidates = own
      ? await nearCandidates(vfs, owner, id, own, { ...(self.takenAtUtc ? { takenAtUtc: self.takenAtUtc } : {}), extra })
      : [...new Set([...(self.duration === undefined ? [] : await recordingsLike(vfs, owner, id, self.duration)), ...extra])].filter((each) => each !== id)
        .map((each) => ({ id: each, vectors: [] as number[][] }));
    const ids = candidates.map((candidate) => candidate.id);
    const [nodes, places] = ids.length > 0 ? await Promise.all([vfs.getNodesByIds(owner, ids), vfs.resolveIdPaths(owner, ids)]) : [new Map(), new Map<string, string[]>()];
    const apart = new Set(separatedFrom(attrs));
    const seen: Seen[] = [];
    for (const candidate of candidates) {
      const other = nodes.get(candidate.id);
      const at = places.get(candidate.id)?.find((each) => isLibraryPath(each) || inboxOf(each) === user);
      if (!other || at === undefined) continue;
      const theirs = other.attrs as Record<string, unknown>;
      if (!isIndexableMedia({ id: candidate.id, type: other.type, attrs: theirs }) || printKindOf(theirs.mimetype) !== kind) continue;
      const found = inboxOf(at) === user ? findingOf(theirs) : undefined;
      if (found?.of !== undefined || found?.hub !== undefined) continue;
      if (apart.has(candidate.id) || separatedFrom(theirs).includes(id)) continue;
      const score = !own
        ? 0
        : kind === 'image'
        ? Math.max(...own.vectors.flatMap((mine) => candidate.vectors.map((vector) => cosine(mine.vector, vector))))
        : keyframeVote(own.vectors.map((mine) => mine.vector), candidate.vectors).share;
      seen.push({ id: candidate.id, path: at, attrs: theirs, score, facts: factsOf(candidate.id, theirs) });
    }
    if (ownSound) {
      const sounds = await chromaprintsOf(vfs, owner, seen);
      for (const each of seen) {
        const theirs = sounds.get(each.id);
        each.score = theirs ? matchChromaprints(ownSound, theirs)?.similarity ?? 0 : 0;
      }
    }
    // Two frames that could be one burst are told apart by their sub-second times, read only for them.
    const burst = kind === 'image' ? seen.filter((each) => each.score >= NEAR.image && sameShot(self, each.facts)) : [];
    if (burst.length > 0) {
      const fractions = await subSecondsOf(vfs, owner, [id, ...burst.map((each) => each.id)]);
      if (fractions.has(id)) self.subSecond = fractions.get(id);
      for (const each of burst) if (fractions.has(each.id)) each.facts.subSecond = fractions.get(each.id);
    }
    const verified = seen.filter((each) =>
      kind === 'image'
        ? nearPictures(self, each.facts, each.score)
        : kind === 'video'
        ? nearVideos(self, each.facts, { share: each.score })
        : nearRecordings(self, each.facts, each.score)
    );
    const ranked = rankPeers(verified.map((each) => ({ id: each.id, score: roundScore(each.score) })));
    hub = ranked.hub;
    peers = ranked.peers.map((peer) => ({ id: peer.id, method: METHODS[kind], score: peer.score }));
    const library = new Set(verified.filter((each) => isLibraryPath(each.path)).map((each) => each.id));
    where = peers.some((peer) => library.has(peer.id)) ? 'library' : 'inbox';
    const kept = new Set(peers.map((peer) => peer.id));
    for (const each of verified) if (kept.has(each.id) && !library.has(each.id)) stagedPeers.set(each.id, findingOf(each.attrs));
  }

  return await withChecksums([sha256], async (): Promise<NearOutcome | undefined> => {
    const now = (await vfs.getNodesByIds(cmd.access, [id])).get(id);
    const current = now && findingOf(now.attrs as Record<string, unknown>);
    if (!now || !current || current.inbox !== user || current.sha256 !== sha256 || current.of !== undefined || checksumOf(now.attrs as Record<string, unknown>) !== sha256) {
      return undefined;
    }
    const base: DuplicateFinding = { inbox: user, sha256, at: timestamp() };
    const desired: DuplicateFinding = peers.length > 0 ? { ...base, kind: 'near', where, peers } : hub ? { ...base, hub: 'many' } : base;
    const before = new Set(peerIds(current));
    const after = new Set(peers.map((peer) => peer.id));
    const joined = [...stagedPeers].filter(([, theirs]) => !peerIds(theirs).includes(id)).map(([peer]) => peer);
    const left = [...before].filter((peer) => !after.has(peer));
    // A finding older than the prints it now says nothing about is stamped anew, so a refresh
    // sees the file was checked with them.
    const fingerprinted = (now.attrs as Record<string, unknown>).fingerprintedAt;
    const checked = !printed || typeof fingerprinted !== 'string' || fingerprinted <= current.at;
    if (sameFinding(current, desired) && checked) return { joined, left };
    await vfs.update(cmd.access, path, { attrs: { [DUPLICATE_ATTR]: desired } });
    return { written: { id, path }, joined, left };
  });
};

/**
 * The near check of the staged files `ids`, one at a time, each with the files `extra` names for
 * it compared too. With `cascade` (the default), each staged look-alike that does not list a file
 * yet is checked again with it, and each the file no longer lists is checked again: one level, so
 * a look-alike is one both ways. Answers the files whose findings were written.
 */
const recordNear = async (
  cmd: Command,
  ids: string[],
  options: { extra?: ReadonlyMap<string, string[]>; cascade?: boolean } = {},
): Promise<NearWritten[]> => {
  const written: NearWritten[] = [];
  const again = new Map<string, Set<string>>();
  const checked = [...new Set(ids)];
  for (const id of checked) {
    const outcome = await nearOne(cmd, id, options.extra?.get(id) ?? []);
    if (!outcome) continue;
    if (outcome.written) written.push(outcome.written);
    if (options.cascade === false) continue;
    for (const peer of outcome.joined) again.set(peer, (again.get(peer) ?? new Set()).add(id));
    for (const peer of outcome.left) again.set(peer, again.get(peer) ?? new Set());
  }
  for (const [peer, alongside] of again) {
    const outcome = await nearOne(cmd, peer, [...alongside]);
    if (outcome?.written) written.push(outcome.written);
  }
  return written;
};

/**
 * `staging separate <file> <other>…`: record that `file` is no duplicate of each of `others`
 * (`undo`: no longer), on each staged file of a pair — a library file is never written — and check
 * the staged ones again, so a look-alike recorded apart leaves both findings, and one no longer
 * apart can come back. Refused for byte twins, which are copies whatever a person says, and for a
 * pair with no staged file.
 */
export const separate = async (cmd: Command, file: string, others: string[], undo: boolean): Promise<DuplicateSeparateResult> => {
  const { vfs } = cmd.sys;
  const found = await nodesAt(vfs, cmd.access, [file, ...others]);
  const node = (path: string) => {
    const each = found.get(path);
    if (!each || each.type !== 'file') throw new Error(`not a file: ${path}`);
    return each;
  };
  const first = node(file);
  /** Per staged file, by path, the ids its decision gains or loses. */
  const changes = new Map<string, { id: string; attrs: Record<string, unknown>; ids: Set<string> }>();
  const note = (path: string, at: typeof first, other: string) => {
    if (inboxOf(path) === undefined) return;
    const change = changes.get(path) ?? { id: at.id, attrs: at.attrs as Record<string, unknown>, ids: new Set<string>() };
    change.ids.add(other);
    changes.set(path, change);
  };
  for (const other of others) {
    const second = node(other);
    if (second.id === first.id) throw new Error(`${other} is ${file}`);
    if (inboxOf(file) === undefined && inboxOf(other) === undefined) throw new Error(`neither ${file} nor ${other} is staged`);
    const sum = checksumOf(first.attrs as Record<string, unknown>);
    if (sum !== undefined && sum === checksumOf(second.attrs as Record<string, unknown>)) throw new Error(`${file} and ${other} are the same bytes: copies, not look-alikes`);
    note(file, first, second.id);
    note(other, second, first.id);
  }

  const writes = [...changes].flatMap(([path, change]) => {
    const before = separatedFrom(change.attrs);
    const after = undo ? before.filter((id) => !change.ids.has(id)) : [...new Set([...before, ...change.ids])].sort();
    if (after.length === before.length && after.every((id, i) => id === before[i])) return [];
    const decision: DuplicateDecision | null = after.length > 0 ? { separate: after } : null;
    return [{ ref: path, attrs: { [DECISION_ATTR]: decision } }];
  });
  if (writes.length > 0) {
    const refused = (await vfs.updateEach(cmd.access, writes)).find((outcome) => outcome.status === 'rejected');
    if (refused) throw refused.reason;
  }
  const extra = new Map([...changes.values()].map((change) => [change.id, undo ? [...change.ids] : []] as const));
  await recordNear(cmd, [...extra.keys()], { extra });
  return { ok: true, pairs: others.length, undone: undo };
};
