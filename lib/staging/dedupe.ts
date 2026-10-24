/**
 * Resolving a staging inbox's duplicate sets: `staging dedupe`. Each set's copies are merged into
 * the file it keeps — filled in, never overwritten (`@archive/media/merge-duplicates`) — and then
 * discarded, so nothing a person said about a copy lives only in the trash.
 *
 * One call is one decision: one journal entry (`dedupe`, which `staging undo` takes) and one trash
 * batch, however many sets it resolves, up to `DEDUPE_SETS_MAX` sets and `DEDUPE_FILES_MAX`
 * copies. Every set is read again when the call runs (`@archive/staging/duplicate-read`), so what
 * is resolved is what is there now: a set whose kept file is gone, other bytes now, or would be
 * filled in without the caller's write is left alone and said. The files dropped are those in the
 * call's folder, which lies in one category, as a decision does, or among a suggested group's
 * members. A set of look-alikes is resolved when a person names it; `--apply` takes only those the
 * rules say are safe unasked (`bulk`).
 */
import type { DuplicateCounts, DuplicateKind, DuplicateResolveResult, DuplicateSet, DuplicateWhere } from '@archive/media/api';
import { fillKept, type MergedSet, planMerge } from '@archive/media/merge-duplicates';
import { CATEGORY_ATTR, parseCategorySettings } from '@archive/staging/category';
import { countDuplicates, type DuplicateScope, duplicateScope, groupScope, readKeyedSets, type ReadSet, readSets } from '@archive/staging/duplicate-read';
import { discardStagedMany } from '@archive/staging/file';
import { categoryPath, parseStagedPath } from '@archive/staging/paths';
import type { Command } from '@ein/client';

/** Sets one call resolves at most, and copies it drops at most. */
export const DEDUPE_SETS_MAX = 500;
export const DEDUPE_FILES_MAX = 2_000;

/** Sets one `--apply` call looks at, resolved or left alone, before it hands back a cursor. */
const EXAMINED_MAX = 2_000;

/** A scope `staging dedupe` works in: a category of the inbox, a folder in one, or a suggested group. */
type DedupeScope = DuplicateScope & { category: string };

/** `path` as the scope of a dedupe in `user`'s inbox. Throws for one that is not in one category. */
export const dedupeScope = (user: string, path: string): DedupeScope => {
  const scope = duplicateScope(user, path);
  const category = parseStagedPath(scope.path)?.category;
  if (scope.whole || category === undefined) throw new Error('staging dedupe works in one category: name it, or a folder in it');
  return { ...scope, category };
};

/** The suggested group `path` of `user`'s as the scope of a dedupe: its members, in its category. */
export const dedupeGroupScope = async (cmd: Command, user: string, path: string): Promise<DedupeScope> => {
  const scope = await groupScope(cmd, user, path);
  return { ...scope, category: parseStagedPath(scope.path)!.category! };
};

const copiesWord = (count: number): string => `${count.toLocaleString('en')} ${count === 1 ? 'copy' : 'copies'}`;

/** The path of the member `id` of `set`, or of a byte copy that goes with one. */
const pathIn = (set: DuplicateSet, id: string): string => {
  const members = [...set.staged, ...set.existing];
  const path = members.find((each) => each.id === id)?.path ?? members.flatMap((each) => each.copies).find((copy) => copy.id === id)?.path;
  if (path === undefined) throw new Error(`${set.key}: ${id} is not in it`);
  return path;
};

/** What resolving some sets did, before the paging part of the answer. */
type Resolved = Pick<DuplicateResolveResult, 'resolved' | 'discarded' | 'journal' | 'batch' | 'merged'>;

/**
 * Resolve `sets`, all resolvable, as one decision: plan every merge from the files as the sets were
 * read (refusing the whole call before anything changes when one cannot be made), then one journal
 * entry and one batch that first fill the kept files in and then discard the copies. A dry run
 * plans only.
 */
const resolveSets = async (cmd: Command, scope: DedupeScope, reads: ReadSet[], dryRun: boolean): Promise<Resolved> => {
  const sets = reads.map((read) => read.set);
  const pairs = sets.map((set) => ({ keep: pathIn(set, set.keep), drops: set.discard.map((id) => pathIn(set, id)) }));
  const drops = pairs.flatMap((pair) => pair.drops);
  if (sets.length === 0) return { resolved: 0, discarded: 0, journal: null, batch: null, merged: [] };
  const known = new Map(reads.flatMap((read) => read.members.map((member) => [member.path, member] as const)));
  const plan = await planMerge(cmd, pairs, known);
  if (dryRun) {
    return { resolved: sets.length, discarded: drops.length, journal: null, batch: null, merged: plan.sets.map((set) => ({ keep: set.keep.path, fields: set.merged })) };
  }

  const category = await cmd.sys.vfs.get<Record<string, unknown>>(cmd.access, categoryPath(scope.user, scope.category));
  const label = parseCategorySettings(category.attrs[CATEGORY_ATTR], scope.category).label;
  let merged: MergedSet[] = [];
  const discarded = await discardStagedMany(cmd, scope.user, scope.category, drops, {
    label: `Duplicates from ${label}: ${copiesWord(drops.length)}`,
    action: 'dedupe',
    summary: (files) => `${copiesWord(files)} of ${sets.length.toLocaleString('en')} ${sets.length === 1 ? 'photo' : 'photos'} removed`,
    before: async () => {
      merged = await fillKept(cmd, plan);
    },
  });
  if (discarded.failed.length > 0) {
    const [first] = discarded.failed;
    throw new Error(
      `${discarded.failed.length} of ${drops.length} copies did not go to the trash, the first ${first.path}: ${first.error}; journal entry ${discarded.journal} undoes the rest`,
    );
  }
  return { resolved: sets.length, discarded: drops.length, journal: discarded.journal, batch: discarded.batches[0] ?? null, merged };
};

/**
 * `staging dedupe <key>…`: the sets `keys` name, read now, resolved as one decision, keeping
 * `keep` (a staged file's id) in the set holding it. A set that changed since — nothing left to
 * drop in the folder, its kept file gone — or that cannot be resolved as it is, is left alone and
 * said; a set of look-alikes that `--apply` would leave for a person is resolved, as one names it.
 */
export const dedupeKeys = async (
  cmd: Command,
  scope: DedupeScope,
  keys: string[],
  options: { keep?: string; dryRun?: boolean } = {},
): Promise<DuplicateResolveResult> => {
  const unique = [...new Set(keys)];
  if (unique.length > DEDUPE_SETS_MAX) throw new Error(`staging dedupe takes at most ${DEDUPE_SETS_MAX} sets`);
  if (options.keep !== undefined && unique.length !== 1) throw new Error('--keep is for one set');
  const read = await readKeyedSets(cmd, scope, unique, options.keep);
  const taken: ReadSet[] = [];
  const skipped: DuplicateResolveResult['skipped'] = [];
  for (const key of unique) {
    const found = read.get(key);
    const set = found?.set;
    if (options.keep !== undefined && set && set.keep !== options.keep) throw new Error(`${options.keep} is not a staged file of ${key}`);
    if (!found || !set || set.discard.length === 0) skipped.push({ key, reason: 'changed' });
    else if (set.blocked && set.blocked !== 'needs-review') skipped.push({ key, reason: set.blocked });
    else taken.push(found);
  }
  if (taken.reduce((sum, { set }) => sum + set.discard.length, 0) > DEDUPE_FILES_MAX) throw new Error(`staging dedupe drops at most ${DEDUPE_FILES_MAX} copies a call`);
  const resolved = await resolveSets(cmd, scope, taken, options.dryRun === true);
  return { ok: true, dryRun: options.dryRun === true, ...resolved, skipped, cursor: null, more: false, remaining: null };
};

/** The files counted in the classes `kind` and `where` leave. */
const remainingOf = (counts: DuplicateCounts, kind?: DuplicateKind, where?: DuplicateWhere): number => {
  const kinds: DuplicateKind[] = kind ? [kind] : ['exact', 'near'];
  const wheres: DuplicateWhere[] = where ? [where] : ['library', 'inbox'];
  return kinds.reduce((sum, each) => sum + wheres.reduce((part, place) => part + counts[each][place], 0), 0);
};

/**
 * `staging dedupe <scope> --apply`: the scope's sets that resolve unasked (`bulk`), of the classes
 * `kind` and `where` leave, from `cursor` on, resolved as one decision, up to `DEDUPE_SETS_MAX`
 * sets and `limit` files. The sets left alone are said, and passed: `cursor` goes on after the
 * last set looked at, and `more` says there is more to look at; the caller calls again until it
 * is false. `remaining` counts the files of those classes still found.
 */
export const dedupeApply = async (
  cmd: Command,
  scope: DedupeScope,
  options: { kind?: DuplicateKind; where?: DuplicateWhere; limit?: number; cursor?: string; dryRun?: boolean } = {},
): Promise<DuplicateResolveResult> => {
  const limit = options.limit ?? DEDUPE_FILES_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > DEDUPE_FILES_MAX) throw new Error(`--limit is a whole number of copies from 1 to ${DEDUPE_FILES_MAX}`);
  const taken: ReadSet[] = [];
  const skipped: DuplicateResolveResult['skipped'] = [];
  let files = 0;
  let looked = 0;
  let cursor = options.cursor ?? null;
  let more = false;
  read: for (;;) {
    // As many sets as could still be taken or looked at, each dropping a copy at least.
    const want = Math.min(DEDUPE_SETS_MAX - taken.length, EXAMINED_MAX - looked, Math.max(1, limit - files));
    const page = await readSets(cmd, scope, {
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.where ? { where: options.where } : {}),
      limit: want,
      ...(cursor ? { cursor } : {}),
    });
    for (const [index, read] of page.placed.entries()) {
      const { set, next } = read;
      if (!set.bulk) skipped.push({ key: set.key, reason: set.blocked ?? 'changed' });
      else if (taken.length > 0 && files + set.discard.length > limit) {
        more = true;
        break read;
      } else {
        taken.push(read);
        files += set.discard.length;
      }
      cursor = next;
      looked++;
      if (taken.length === DEDUPE_SETS_MAX || looked === EXAMINED_MAX) {
        more = index < page.placed.length - 1 || page.cursor !== null;
        break read;
      }
    }
    cursor = page.cursor;
    if (cursor === null) break;
  }
  const resolved = await resolveSets(cmd, scope, taken, options.dryRun === true);
  const counts = await countDuplicates(cmd, scope);
  return {
    ok: true,
    dryRun: options.dryRun === true,
    ...resolved,
    skipped,
    cursor: more ? cursor : null,
    more,
    remaining: remainingOf(counts, options.kind, options.where),
  };
};
