/**
 * The ways staged files leave their inbox, each journaled: filed into a library album (shared as
 * the album is, out of the inbox's suggestions, and moved with every link to them), or discarded
 * into the trash (out of the suggestions, then into trash batches). Staged files going anywhere
 * else leave the suggestions first the same way (`leaveSuggestedAlbums`). Either way the inbox's
 * duplicate findings are kept true as they go (`@archive/staging/duplicates`).
 *
 * A decision is planned before anything changes (`planFiling`, `snapshotGroups`): every move by
 * node id and every group link that will leave, which its journal entry holds so `staging undo`
 * can put each back.
 */

import type { GroupSnapshot, StagedAccess, StagingUndoPlan } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { shq, verifyAccess } from '@ein/client';
import { monotonicUlid } from '@std/ulid';
import { basename, join } from '@std/path';
import { groupsDirOf, parseStagedPath, stagedPlace } from '@archive/staging/paths';
import { leaveSuggestedAlbums, snapshotGroups, suggestionsOf } from '@archive/staging/membership';
import { createJournalEntry, finishJournalEntry, type JournalDraft, type JournalEntry } from '@archive/staging/journal';
import { forgetStaged, markTrashed, refreshReferences } from '@archive/staging/duplicates';
import { idsAt, nodesAt } from '@archive/staging/nodes-at';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Paths per `share-set` and per `trash put`, so a command line stays short however many files there are. */
const COMMAND_CHUNK = 200;

/** Entries one trash batch holds at most. */
const TRASH_BATCH = 2_000;

/** One staged file filed: where it was staged, where it is now, and how many links to it followed. */
type FiledFile = { path: string; to: string; relinked: number };

/** A move or a trashing that did not happen, and why. */
type Failure = { path: string; error: string };

/** `name`, or `name (2).ext`, `name (3).ext`, … — the first not in `used`. */
export const freeName = (name: string, used: Set<string>): string => {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2;; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
};

/** Staged files planned to be filed into `albumDir`: each one's move, and the groups they leave. */
type FilingPlan = {
  albumDir: string;
  moves: ({ id: string; from: string; to: string } & StagedAccess)[];
  groups: GroupSnapshot[];
  /** The files by the directory of their inbox's suggested groups. */
  inboxes: Map<string, string[]>;
};

/**
 * Plan filing staged `files` into `albumDir`, a directory of a library album outside staging,
 * reading only: each file under its own name or the first free one there (`freeName`), with its
 * id and its sharing now, and the groups it will leave. An `albumDir` that is not there yet, one a
 * promote is about to move there, has the names of `movingIn` taken, the directory that will be it;
 * one that will be made is taken as empty. The caller checks it may make either.
 *
 * Throws for a file that is not staged, and for an existing `albumDir` the caller cannot write
 * into.
 */
export const planFiling = async (cmd: Command, files: string[], albumDir: string, movingIn?: string): Promise<FilingPlan> => {
  const { vfs } = cmd.sys;
  const unique = [...new Set(files)];
  if (parseStagedPath(albumDir) !== undefined) throw new Error(`${albumDir} is in staging, not in the library`);
  const inboxes = new Map<string, string[]>();
  for (const file of unique) {
    const albums = suggestionsOf(file);
    if (!albums) throw new Error(`not a staged file: ${file}`);
    inboxes.set(albums, [...inboxes.get(albums) ?? [], file]);
  }

  const dir = await vfs.get(cmd.access, albumDir).catch(() => undefined);
  if (dir && (!verifyAccess(cmd.access, dir.props, 'w') || !verifyAccess(cmd.access, dir.props, 'x'))) throw new Error(`cannot write into ${albumDir}`);
  const named = dir ? albumDir : movingIn !== undefined && await vfs.exists(cmd.access, movingIn) ? movingIn : undefined;
  const used = new Set(named ? (await vfs.children(cmd.access, named)).map((entry) => entry.name) : []);

  const ids = await idsAt(vfs, cmd.access, unique);
  const missing = unique.find((file) => !ids.has(file));
  if (missing) throw new Error(`not found: ${missing}`);
  const nodes = await vfs.getNodesByIds(cmd.access, [...ids.values()]);
  const moves = unique.map((file) => {
    const id = ids.get(file)!;
    const props = nodes.get(id)?.props;
    const name = freeName(basename(file), used);
    used.add(name);
    return {
      id,
      from: file,
      to: join(albumDir, name),
      mode: props?.mode ?? 0o600,
      gid: props?.gid ?? cmd.access.gid,
      ...(props?.acl && props.acl.length > 0 ? { acl: props.acl } : {}),
    };
  });

  const groups: GroupSnapshot[] = [];
  for (const [albumsPath, staged] of inboxes) groups.push(...await snapshotGroups(vfs, cmd.access, staged, albumsPath));
  return { albumDir, moves, groups, inboxes };
};

/** What carrying out a filing plan did. */
type Filed = { filed: FiledFile[]; failed: Failure[]; groupsRemoved: string[]; groupsChanged: string[] };

/**
 * Carry out `plan`, whose `albumDir` exists by now:
 *
 * 1. each file is shared as `albumDir` is (`share-set --reference`), so a file that cannot be stays
 *    private where it was;
 * 2. the files leave their inbox's suggested albums, which group only what is still in the inbox;
 * 3. they move as planned in one `renameMany`, and the links to each — and to anything under it —
 *    follow in the same transactions;
 * 4. the files that moved lose their duplicate findings, and their byte twins left in the inbox
 *    are decided again (`forgetStaged`).
 *
 * A move that fails is answered in `failed`; the files that moved stay filed.
 */
export const applyFiling = async (cmd: Command, plan: FilingPlan): Promise<Filed> => {
  const { vfs } = cmd.sys;
  const files = plan.moves.map((move) => move.from);
  for (let i = 0; i < files.length; i += COMMAND_CHUNK) {
    const chunk = files.slice(i, i + COMMAND_CHUNK);
    const share = await cmd.execute(`share-set --reference ${shq(plan.albumDir)} ${chunk.map(shq).join(' ')}`);
    if (share.code !== 0) throw new Error(share.stderr.trim() || `failed to share the files as ${plan.albumDir}`);
  }

  const result: Filed = { filed: [], failed: [], groupsRemoved: [], groupsChanged: [] };
  for (const [albumsPath, staged] of plan.inboxes) {
    const left = await leaveSuggestedAlbums(vfs, cmd.access, staged, albumsPath);
    result.groupsRemoved.push(...left.removed);
    result.groupsChanged.push(...left.changed);
  }

  const settled = await vfs.renameMany(cmd.access, plan.moves.map(({ from, to }) => ({ from, to })), { failIfExists: true });
  settled.forEach((outcome, i) => {
    const { from, to } = plan.moves[i];
    if (outcome.status === 'fulfilled') result.filed.push({ path: from, to, relinked: outcome.value.relinked });
    else result.failed.push({ path: from, error: messageOf(outcome.reason) });
  });
  await forgetStaged(cmd, plan.moves.filter((_, i) => settled[i].status === 'fulfilled'));
  return result;
};

/** The words a journal entry's summary uses for `count` files. */
export const filesWord = (count: number): string => `${count.toLocaleString('en')} ${count === 1 ? 'file' : 'files'}`;

/** The undo plan of a filing. */
const filedPlan = (plan: FilingPlan): StagingUndoPlan => ({ kind: 'filed', moves: plan.moves, groups: plan.groups });

/**
 * File staged `files` into `albumDir`, a directory of the library album `album` (`planFiling`,
 * `applyFiling`), one journal entry per staging category they come from, recorded as `file`
 * decisions. Answers what moved and the entries; throws, once every entry is finished, when any
 * file did not move — the files that moved stay filed, and their entries undo them.
 */
export const fileStagedMany = async (
  cmd: Command,
  files: string[],
  albumDir: string,
  album: { id: string; title: string; created: boolean },
): Promise<{ filed: FiledFile[]; journal: string[] }> => {
  const byCategory = new Map<string, { user: string; category: string; files: string[] }>();
  for (const file of new Set(files)) {
    const place = stagedPlace(file);
    if (!place) throw new Error(`not a staged file: ${file}`);
    const key = `${place.user}/${place.category}`;
    const entry = byCategory.get(key) ?? { ...place, files: [] };
    entry.files.push(file);
    byCategory.set(key, entry);
  }

  const filed: FiledFile[] = [];
  const failed: Failure[] = [];
  const journal: string[] = [];
  for (const { user, category, files: staged } of byCategory.values()) {
    const plan = await planFiling(cmd, staged, albumDir);
    const entry = await createJournalEntry(cmd.sys.vfs, cmd.access, user, {
      category,
      action: 'file',
      files: plan.moves.length,
      summary: `${filesWord(plan.moves.length)} → ${album.title}`,
      albums: [album.id],
      ...(album.created ? { created: [album.id] } : {}),
    }, filedPlan(plan));
    journal.push(entry.id);
    let state: 'done' | 'partial' = 'partial';
    try {
      const result = await applyFiling(cmd, plan);
      filed.push(...result.filed);
      failed.push(...result.failed);
      if (result.failed.length === 0) state = 'done';
    } finally {
      await finishJournalEntry(cmd.sys.vfs, cmd.access, entry, { state });
    }
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${files.length} staged files did not move to ${albumDir}; the first, ${failed[0].path}: ${failed[0].error}`);
  }
  return { filed, journal };
};

/**
 * What `paths` are: how many staged originals they hold (a file is one, a folder the originals
 * within it), the files as read, and the folders. Read together (`nodesAt`); throws for a path
 * with nothing at it.
 */
const readTargets = async (vfs: Vfs, access: Access, paths: string[]) => {
  const targets = { count: 0, files: [] as { id: string; path: string; attrs: Record<string, unknown> }[], dirs: [] as string[] };
  const nodes = await nodesAt(vfs, access, paths);
  for (const path of paths) {
    const node = nodes.get(path) ?? await vfs.get(access, path, { follow: false });
    if (node.type === 'directory') {
      const buckets = await vfs.aggregate(access, { within: path, types: ['file'], where: [{ ref: 'sourceId', op: 'missing' }], group: [{ column: 'type' }] });
      targets.count += buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      targets.dirs.push(path);
    } else {
      if (node.attrs.sourceId === undefined) targets.count++;
      targets.files.push({ id: node.id, path, attrs: node.attrs as Record<string, unknown> });
    }
  }
  return targets;
};

/** What a discard did: its entry, the originals it counted, its batches, the groups the files left, and what did not go. */
type Discarded = { journal: string; files: number; batches: string[]; groupsRemoved: string[]; groupsChanged: string[]; failed: Failure[] };

/** What a discard is recorded as, and what runs first. */
type DiscardOptions = {
  /** The trash batches' label. */
  label: string;
  /** The suggested groups the discard decided, for the journal. */
  groups?: { slug: string; name: string }[];
  /** `dedupe` for copies dropped by `staging dedupe`; `discard` otherwise. */
  action?: 'discard' | 'dedupe';
  /** The journal's summary; `<n> files discarded` otherwise. */
  summary?: (files: number) => string;
  /** Changes the decision makes before its files go, once its entry is made: a merge's fill-ins. */
  before?: () => Promise<void>;
};

/**
 * Discard `paths` — staged files and folders, all in `user`'s category `category` — into the
 * caller's trash, as one journal entry made before anything changes:
 *
 * 1. `options.before`, when given;
 * 2. their duplicate findings take the trashed form (`markTrashed`), so none is in the inbox's
 *    findings while they are in the trash;
 * 3. they leave the category's suggested groups (`leaveSuggestedAlbums`), a group left empty
 *    deleted;
 * 4. they go into trash batches of at most 2,000 entries, labelled `options.label`, whose ids are
 *    chosen beforehand and recorded in the plan, a few hundred paths per `trash put`;
 * 5. the copies of the originals among them, left in the inbox, are decided again, and their
 *    look-alikes left there checked again (`refreshReferences`).
 *
 * A step that fails stops there: a `trash put` that fails answers what it held in `failed`, and
 * anything else throws; either way the entry is `partial`, and undoing it restores the batches
 * that were made.
 */
export const discardStagedMany = async (cmd: Command, user: string, category: string, paths: string[], options: DiscardOptions): Promise<Discarded> => {
  const { vfs } = cmd.sys;
  const unique = [...new Set(paths)];
  const albumsPath = groupsDirOf(`${unique[0]}`);
  for (const path of unique) {
    const place = stagedPlace(path);
    if (place?.user !== user || place.category !== category) throw new Error(`not staged in ${user}'s ${category}: ${path}`);
  }
  const home = cmd.env.HOME;
  if (!home || home === '/') throw new Error('no home directory to keep the trash in');

  const targets = await readTargets(vfs, cmd.access, unique);
  const files = targets.count;
  const snapshots = albumsPath ? await snapshotGroups(vfs, cmd.access, unique, albumsPath) : [];
  const batches = Array.from({ length: Math.ceil(unique.length / TRASH_BATCH) }, () => monotonicUlid());
  const draft: JournalDraft = {
    category,
    action: options.action ?? 'discard',
    files,
    summary: options.summary ? options.summary(files) : `${filesWord(files)} discarded`,
    batches,
    ...(options.groups && options.groups.length > 0 ? { groups: options.groups } : {}),
  };
  const entry: JournalEntry = await createJournalEntry(vfs, cmd.access, user, draft, { kind: 'trashed', home, batches, groups: snapshots });

  const result: Discarded = { journal: entry.id, files, batches: [], groupsRemoved: [], groupsChanged: [], failed: [] };
  let state: 'done' | 'partial' = 'partial';
  let marked: Awaited<ReturnType<typeof markTrashed>> | undefined;
  try {
    await options.before?.();
    marked = await markTrashed(cmd, user, targets.files, targets.dirs);
    if (albumsPath) {
      const left = await leaveSuggestedAlbums(vfs, cmd.access, unique, albumsPath);
      result.groupsRemoved.push(...left.removed);
      result.groupsChanged.push(...left.changed);
    }
    const quotedLabel = shq(options.label);
    for (const [index, batch] of batches.entries()) {
      const inBatch = unique.slice(index * TRASH_BATCH, (index + 1) * TRASH_BATCH);
      for (let i = 0; i < inBatch.length; i += COMMAND_CHUNK) {
        const chunk = inBatch.slice(i, i + COMMAND_CHUNK);
        const put = await cmd.execute(`JSON_OUTPUT=1 trash put --batch=${batch} --label ${quotedLabel} ${chunk.map(shq).join(' ')}`);
        if (put.code !== 0) {
          const error = put.stderr.trim() || 'failed to move to the trash';
          result.failed.push(...unique.slice(index * TRASH_BATCH + i).map((path) => ({ path, error })));
          return result;
        }
        if (!result.batches.includes(batch)) result.batches.push(batch);
      }
    }
    state = 'done';
    return result;
  } finally {
    try {
      if (marked) await refreshReferences(cmd, user, state === 'done' ? marked.originals : marked.all, state === 'done' ? marked.peers : [...marked.peers, ...marked.ids]);
    } finally {
      await finishJournalEntry(vfs, cmd.access, entry, { state, batches: result.batches });
    }
  }
};
