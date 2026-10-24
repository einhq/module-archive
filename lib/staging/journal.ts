/**
 * The staging journal: one entry per decision made in a staging area, `staging/journal/<ulid>`,
 * the one writer of entries. An entry is a db-tier JSON file owned as the area is, 0600: its
 * `attrs.stagingJournal` say what was decided (indexed as `staging_journal`, on inbox, category
 * and time), and its body is the plan that undoes it (`StagingUndoPlan`).
 *
 * An entry is made, `planned` and with its whole plan, before the decision changes anything; it
 * becomes `done` or `partial` once the decision ends, however it ends. It is never deleted: undo
 * sets `undoneAt`, and a second undo is refused.
 *
 * A grouping edit's entry also keeps the edit itself (`attrs.stagingEdit`), which the organizer
 * applies on every run while the entry is not undone (`liveEdits`, off the `staging_edit` index); a
 * rejection's, the album and the members it is rejected for (`attrs.stagingReject`), which matching
 * honours while it is not undone; a promote's, the matches the group had when the person chose
 * (`attrs.stagingMatchDecision`).
 */
import type {
  StagingDecidedTotals,
  StagingEdit,
  StagingJournalAction,
  StagingJournalAttrs,
  StagingJournalEntry,
  StagingJournalPage,
  StagingMatchDecision,
  StagingReject,
  StagingUndoPlan,
  StagingUndoResult,
} from '@archive/staging/api';
import type { Command } from '@ein/client';
import { monotonicUlid } from '@std/ulid';
import { basename } from '@std/path';
import { stagingRoots } from '@archive/staging/paths';
import { undoFiled, undoGroups, type UndoOutcome, undoTrashed } from '@archive/staging/undo';
import { MATCHES_ATTR, REJECT_ATTR } from '@archive/staging/match';
import { categoryAlbumsPath } from '@archive/staging/paths';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The attr an entry carries. */
const JOURNAL_ATTR = 'stagingJournal';
/** The attrs a grouping edit's, a rejection's and a promote's entry carry beside it. */
const EDIT_ATTR = 'stagingEdit';
const MATCH_DECISION_ATTR = 'stagingMatchDecision';

/** What an entry keeps beside what was decided: a grouping edit, a rejection, or the matches a promote was chosen from. */
type JournalExtras = { edit?: StagingEdit; reject?: StagingReject; matchDecision?: StagingMatchDecision };

/** Entries `staging journal` lists per page at most, and undoes per call. */
export const JOURNAL_PAGE_MAX = 200;
export const UNDO_MAX = 20;

const ENTRY_MIME = 'application/json';
const ENTRY_MODE = 0o600;
const ENTRY_NAME = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A field of `stagingJournal`, as a query reads it. */
const field = (name: keyof StagingJournalAttrs) => ({ path: [JOURNAL_ATTR, name] });

/** An entry being written: where it is, and its attrs as last written. */
export type JournalEntry = { id: string; path: string; attrs: StagingJournalAttrs };

/** What a decision says of itself when its entry is made; the rest is the journal's. */
export type JournalDraft = Omit<StagingJournalAttrs, 'inbox' | 'at' | 'state' | 'undoneAt'>;

const encoder = new TextEncoder();

const writeBody = async (vfs: Vfs, access: Access, path: string, plan: StagingUndoPlan): Promise<void> => {
  const bytes = encoder.encode(JSON.stringify(plan));
  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
  await vfs.update(access, path, { attrs: { size: bytes.length } });
};

/**
 * Make `user`'s entry for a decision about to be made in `category`: `planned`, with `plan` as its
 * body and what it keeps beside (`extras`), owned as the staging area is. Made before the
 * decision's first change.
 */
export const createJournalEntry = async (
  vfs: Vfs,
  access: Access,
  user: string,
  draft: JournalDraft,
  plan: StagingUndoPlan,
  extras: JournalExtras = {},
): Promise<JournalEntry> => {
  const { journalPath, homePath } = stagingRoots(user);
  const home = await vfs.get(access, homePath);
  const id = monotonicUlid();
  const path = `${journalPath}/${id}`;
  const attrs: StagingJournalAttrs = { ...draft, inbox: user, at: new Date().toISOString(), state: 'planned' };
  await vfs.create(access, 'file', journalPath, id, {
    props: { uid: home.props.uid, gid: home.props.gid, mode: ENTRY_MODE, tier: 'db' },
    attrs: {
      [JOURNAL_ATTR]: attrs,
      ...(extras.edit ? { [EDIT_ATTR]: extras.edit } : {}),
      ...(extras.reject ? { [REJECT_ATTR]: extras.reject } : {}),
      ...(extras.matchDecision ? { [MATCH_DECISION_ATTR]: extras.matchDecision } : {}),
      mimetype: ENTRY_MIME,
      size: 0,
    },
  });
  await writeBody(vfs, access, path, plan);
  return { id, path, attrs };
};

/**
 * Record how a decision ended: `state` and whatever else it learnt (the albums it made, the
 * batches it used), and, when it changed, the plan. The entry's attrs are written whole.
 */
export const finishJournalEntry = async (
  vfs: Vfs,
  access: Access,
  entry: JournalEntry,
  change: Partial<StagingJournalAttrs> & { state: 'done' | 'partial' },
  plan?: StagingUndoPlan,
): Promise<void> => {
  if (plan) await writeBody(vfs, access, entry.path, plan);
  entry.attrs = { ...entry.attrs, ...change };
  await vfs.update(access, entry.path, { attrs: { [JOURNAL_ATTR]: entry.attrs } });
};

/** `user`'s entry `id` (its name under `journal/`): its attrs, plan and rejection. Throws for one that is not there. */
const readJournalEntry = async (
  vfs: Vfs,
  access: Access,
  user: string,
  id: string,
): Promise<JournalEntry & { plan: StagingUndoPlan | null; reject?: StagingReject }> => {
  if (!ENTRY_NAME.test(id)) throw new Error(`not a journal entry: ${id}`);
  const path = `${stagingRoots(user).journalPath}/${id}`;
  const node = await vfs.get<{ [JOURNAL_ATTR]?: StagingJournalAttrs; [REJECT_ATTR]?: StagingReject }>(access, path).catch(() => undefined);
  const attrs = node?.attrs[JOURNAL_ATTR];
  if (!attrs) throw new Error(`no journal entry ${id}`);
  let plan: StagingUndoPlan | null = null;
  try {
    const handle = await vfs.open(access, path, { mode: 'r' });
    try {
      plan = JSON.parse(await new Response(handle.readable).text()) as StagingUndoPlan;
    } finally {
      await handle.close();
    }
  } catch {
    // An entry whose plan never got written (the process died making it) changed nothing.
  }
  const reject = node?.attrs[REJECT_ATTR];
  return { id, path, attrs, plan, ...(reject ? { reject } : {}) };
};

type ListOptions = { category?: string; action?: StagingJournalAction; limit: number; cursor?: string };

const encodeCursor = (value: string | null, id: string): string => btoa(JSON.stringify([value, id]));
const decodeCursor = (cursor: string): { value: string | null; id: string } => {
  try {
    const [value, id] = JSON.parse(atob(cursor)) as [string | null, string];
    if (typeof id === 'string') return { value, id };
  } catch {
    // Reported below.
  }
  throw new Error(`invalid cursor '${cursor}'`);
};

/**
 * `user`'s decisions, newest first, a page at a time: in one category or all, of one action or
 * all. One indexed keyset query (`staging_journal`), the destinations of the page in one batched
 * read, and the totals in one aggregate. An entry is listed only where `user`'s journal holds it.
 */
export const listJournal = async (vfs: Vfs, access: Access, user: string, options: ListOptions): Promise<StagingJournalPage> => {
  const { journalPath } = stagingRoots(user);
  const limit = Math.min(Math.max(1, options.limit), JOURNAL_PAGE_MAX);
  const rows = await vfs.query(access, {
    types: ['file'],
    where: [
      { ref: field('inbox'), op: 'eq', value: user },
      ...(options.category !== undefined ? [{ ref: field('category'), op: 'eq' as const, value: options.category }] : []),
      ...(options.action !== undefined ? [{ ref: field('action'), op: 'eq' as const, value: options.action }] : []),
    ],
    orderBy: { ref: field('at'), dir: 'desc' },
    ...(options.cursor ? { after: decodeCursor(options.cursor) } : {}),
    limit,
  });
  const own = rows.filter((row) => row.absPath === `${journalPath}/${basename(row.absPath)}`);
  const attrsOf = (row: (typeof rows)[number]) => (row.node.attrs as { [JOURNAL_ATTR]: StagingJournalAttrs })[JOURNAL_ATTR];
  const editOf = (row: (typeof rows)[number]) => (row.node.attrs as { [EDIT_ATTR]?: StagingEdit })[EDIT_ATTR];
  const rejectOf = (row: (typeof rows)[number]) => (row.node.attrs as { [REJECT_ATTR]?: StagingReject })[REJECT_ATTR];

  const albumIds = [...new Set(own.flatMap((row) => attrsOf(row).albums?.slice(0, 1) ?? []))];
  const [nodes, paths] = albumIds.length > 0 ? await Promise.all([vfs.getNodesByIds(access, albumIds), vfs.resolveIdPaths(access, albumIds)]) : [new Map(), new Map()];
  const entries = own.map((row): StagingJournalEntry => {
    const attrs = attrsOf(row);
    const albumId = attrs.albums?.[0];
    const edit = editOf(row);
    const reject = rejectOf(row);
    const albumPath = albumId ? paths.get(albumId)?.[0] : undefined;
    const name = albumId ? (nodes.get(albumId)?.attrs as { name?: string } | undefined)?.name : undefined;
    return {
      ...attrs,
      id: basename(row.absPath),
      undoable: attrs.undoneAt === undefined,
      ...(edit ? { edit } : {}),
      ...(reject ? { reject } : {}),
      ...(albumPath ? { destination: { path: albumPath, title: typeof name === 'string' && name ? name : basename(albumPath) } } : {}),
    };
  });
  const last = rows.at(-1);
  return {
    entries,
    cursor: rows.length === limit && last ? encodeCursor(last.sortValue, last.id) : null,
    totals: (await journalTotals(vfs, access, user)).get(options.category ?? '') ?? { filed: 0, discarded: 0 },
  };
};

/** Edits read per page. */
const EDIT_PAGE = 1000;

/**
 * The grouping edits of `user`'s category `category` that are not undone, oldest first: what the
 * organizer applies.
 */
export const liveEdits = async (vfs: Vfs, access: Access, user: string, category: string): Promise<StagingEdit[]> =>
  (await liveEditEntries(vfs, access, user, category)).map((entry) => entry.edit);

/**
 * `liveEdits` with the id of each one's journal entry. One query a page off the `staging_edit`
 * index; an entry counts only where `user`'s journal holds it.
 */
export const liveEditEntries = async (vfs: Vfs, access: Access, user: string, category: string): Promise<{ id: string; edit: StagingEdit }[]> => {
  const { journalPath } = stagingRoots(user);
  const found: { at: string; id: string; edit: StagingEdit }[] = [];
  let after: { value: string | null; id: string } | undefined;
  while (true) {
    const rows = await vfs.query(access, {
      types: ['file'],
      where: [
        { ref: field('inbox'), op: 'eq', value: user },
        { ref: field('category'), op: 'eq', value: category },
        { ref: { path: [EDIT_ATTR, 'op'] }, op: 'exists' },
        { ref: field('undoneAt'), op: 'missing' },
      ],
      ...(after ? { after } : {}),
      limit: EDIT_PAGE,
    });
    for (const row of rows) {
      if (row.absPath !== `${journalPath}/${basename(row.absPath)}`) continue;
      const attrs = row.node.attrs as { [JOURNAL_ATTR]: StagingJournalAttrs; [EDIT_ATTR]: StagingEdit };
      found.push({ at: attrs[JOURNAL_ATTR].at, id: basename(row.absPath), edit: attrs[EDIT_ATTR] });
    }
    if (rows.length < EDIT_PAGE) break;
    after = { value: null, id: rows[rows.length - 1].id };
  }
  return found.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map(({ id, edit }) => ({ id, edit }));
};

/**
 * What `user` has decided and not undone, in files, per category — and under `''` over every
 * category — from one aggregate. Not access-filtered, as no aggregate is: callers ask only for a
 * user they may act as.
 */
export const journalTotals = async (vfs: Vfs, access: Access, user: string): Promise<Map<string, StagingDecidedTotals>> => {
  const buckets = await vfs.aggregate(access, {
    types: ['file'],
    where: [{ ref: field('inbox'), op: 'eq', value: user }, { ref: field('undoneAt'), op: 'missing' }],
    group: [{ ref: field('category') }, { ref: field('action') }],
    sum: field('files'),
  });
  const totals = new Map<string, StagingDecidedTotals>();
  const add = (category: string, action: string, files: number) => {
    const total = totals.get(category) ?? { filed: 0, discarded: 0 };
    if (action === 'discard' || action === 'dedupe') total.discarded += files;
    else if (action === 'promote' || action === 'file') total.filed += files;
    totals.set(category, total);
  };
  for (const bucket of buckets) {
    const [category, action] = bucket.key;
    add(String(category), String(action), bucket.sum ?? 0);
    add('', String(action), bucket.sum ?? 0);
  }
  return totals;
};

/**
 * Undo `user`'s entries `ids`, newest first, each by its plan (`undoFiled`, `undoTrashed`,
 * `undoGroups`). An entry undone already, or with no plan, is refused; one whose files cannot all
 * come back is undone as far as it can be, and still marked undone, with the files that stayed in
 * `failed`. A rejection undone gives the group it was made on back its matches, while its members
 * are as they were; every other group holding its members loses its matches, so it is matched
 * again with the album it rejected among the candidates once more.
 */
export const undoJournalEntries = async (cmd: Command, user: string, ids: string[]): Promise<StagingUndoResult> => {
  if (ids.length > UNDO_MAX) throw new Error(`undo takes at most ${UNDO_MAX} entries`);
  const { vfs } = cmd.sys;
  const result: StagingUndoResult = { ok: true, undone: [], restoredFiles: 0, restoredGroups: [], failed: [] };
  const entries = [];
  for (const id of new Set(ids)) entries.push(await readJournalEntry(vfs, cmd.access, user, id));
  entries.sort((a, b) => b.attrs.at.localeCompare(a.attrs.at) || b.id.localeCompare(a.id));

  for (const entry of entries) {
    if (entry.attrs.undoneAt !== undefined) {
      result.failed.push({ id: entry.id, reason: `undone already, at ${entry.attrs.undoneAt}` });
      continue;
    }
    if (!entry.plan) {
      result.failed.push({ id: entry.id, reason: 'it has no plan to undo it by' });
      continue;
    }
    let outcome: UndoOutcome;
    try {
      outcome = entry.plan.kind === 'filed'
        ? await undoFiled(cmd, entry.plan, entry.attrs.created ?? [], entry.attrs.albums ?? [])
        : entry.plan.kind === 'trashed'
        ? await undoTrashed(cmd, entry.plan, entry.attrs.batches ?? entry.plan.batches)
        : entry.plan.kind === 'groups'
        ? await undoGroups(cmd, entry.plan)
        : await undoMatches(cmd, user, entry.plan, entry.reject);
    } catch (error) {
      result.failed.push({ id: entry.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    entry.attrs = { ...entry.attrs, undoneAt: new Date().toISOString() };
    await vfs.update(cmd.access, entry.path, { attrs: { [JOURNAL_ATTR]: entry.attrs } });
    result.undone.push(entry.id);
    result.restoredFiles += outcome.restored;
    result.restoredGroups.push(...outcome.groups);
    if (outcome.stayed.length > 0) result.failed.push({ id: entry.id, reason: 'some files have moved since, and stay where they are', files: outcome.stayed });
  }
  return result;
};

/**
 * Undo a rejection: the groups it changed get their matches back while their members are as they
 * were (their member key); the other groups of the category holding its members lose theirs, which
 * were made with the album left out, so the next match offers it again.
 */
const undoMatches = async (cmd: Command, user: string, plan: Extract<StagingUndoPlan, { kind: 'matches' }>, reject?: StagingReject): Promise<UndoOutcome> => {
  const { vfs } = cmd.sys;
  const restored = new Set<string>();
  const paths = await vfs.resolveIdPaths(cmd.access, plan.groups.map((group) => group.id));
  for (const { id, matches } of plan.groups) {
    const path = paths.get(id)?.[0];
    if (!path) continue;
    const node = await vfs.get<{ autoAlbum?: { memberKey?: string } }>(cmd.access, path);
    if (matches && node.attrs.autoAlbum?.memberKey === matches.memberKey) {
      await vfs.update(cmd.access, path, { attrs: { [MATCHES_ATTR]: matches } });
      restored.add(path);
    }
  }
  if (reject) {
    const albumsPath = categoryAlbumsPath(user, reject.category);
    const files = [...(await vfs.resolveIdPaths(cmd.access, reject.members)).values()].flat();
    const holding = new Set<string>();
    if (files.length > 0) {
      for (const link of await vfs.findLinks(cmd.access, files, Number.MAX_SAFE_INTEGER)) {
        const group = link.absPath.slice(0, link.absPath.lastIndexOf('/'));
        if (group.slice(0, group.lastIndexOf('/')) === albumsPath && !restored.has(group)) holding.add(group);
      }
    }
    if (holding.size > 0) await vfs.updateMany(cmd.access, [...holding], { attrs: { [MATCHES_ATTR]: null } });
  }
  return { restored: 0, groups: [], stayed: [] };
};
