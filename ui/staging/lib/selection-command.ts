/**
 * A selection over the Sort stream turned into the general commands that act on it, each within
 * its verb's cap, so a decision over hundreds of groups is a run of bounded calls. Pure, so what
 * is sent is tested without a page.
 *
 * A selection is groups whole (`staging promote`, `discard`, `later`, `accept` over several at
 * once), groups but for some of their pictures (one call each, with `--except`), and pictures one
 * by one (`album add`, `staging discard`). The selection itself never lists a whole group's
 * pictures, and neither do the commands.
 */
import type { SectionSelection } from '@ein/ui/lib';
import * as commands from './decision-commands.ts';

/** A suggested group as a command names it, and as a run counts it. */
export type GroupRef = { name: string; path: string; title: string; memberCount?: number; staging: { memberKey: string } };

/** Groups each `staging promote`, `discard` and `accept` names at most: `staging accept`'s cap. */
const GROUPS_PER_COMMAND = 20;
/** Groups each `staging accept --dry-run` plans at most. */
export const PLAN_PER_COMMAND = 50;
/** Groups each `staging later` names at most. */
const LATER_PER_COMMAND = 100;
/** Pictures each `album add` and `staging discard` names at most. */
const FILES_PER_COMMAND = 500;
/** Journal entries each `staging undo` takes at most. */
const UNDO_PER_COMMAND = 20;
/** Pictures one `staging regroup` moves at most. */
const REGROUP_PER_COMMAND = 2000;

/** A selection by what acts on it. */
export type SelectionParts<G extends GroupRef = GroupRef> = {
  /** Groups selected whole. */
  groups: G[];
  /** Groups selected whole but for some of their pictures. */
  partial: { group: G; except: string[] }[];
  /** Pictures selected one by one, by the group they are in. */
  files: { group: G; paths: string[] }[];
};

/**
 * One call of a run: its command, the groups it decides whole, the groups it changes in part, how
 * many groups it decides (whole or but for some pictures) and how many pictures it moves.
 */
export type Chunk = { command: string; groups: GroupRef[]; touched: GroupRef[]; decides: number; files: number };

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < list.length; start += size) out.push(list.slice(start, start + size));
  return out;
};

const members = (groups: readonly GroupRef[]) => groups.reduce((sum, group) => sum + (group.memberCount ?? 0), 0);

/**
 * The selection by what acts on it, for the groups `rowOf` still knows: a group that left the
 * stream is passed over with what was selected of it.
 */
export function selectionParts<G extends GroupRef>(selection: SectionSelection, rowOf: (name: string) => G | undefined): SelectionParts<G> {
  const parts: SelectionParts<G> = { groups: [], partial: [], files: [] };
  const except = new Map<string, string[]>();
  for (const [path, section] of selection.excluded) except.set(section, [...(except.get(section) ?? []), path]);
  for (const name of selection.sections) {
    const group = rowOf(name);
    if (!group) continue;
    const left = except.get(name);
    if (left && left.length > 0) parts.partial.push({ group, except: left });
    else parts.groups.push(group);
  }
  const files = new Map<string, string[]>();
  for (const [path, section] of selection.items) files.set(section, [...(files.get(section) ?? []), path]);
  for (const [name, paths] of files) {
    const group = rowOf(name);
    if (group) parts.files.push({ group, paths });
  }
  return parts;
}

/** How many groups (whole or in part) and pictures the selection holds. */
export function partsCount(parts: SelectionParts): { groups: number; files: number; whole: number } {
  const files = members(parts.groups) + parts.partial.reduce((sum, { group, except }) => sum + Math.max(0, (group.memberCount ?? 0) - except.length), 0) +
    parts.files.reduce((sum, { paths }) => sum + paths.length, 0);
  return { groups: parts.groups.length + parts.partial.length, files, whole: parts.groups.length };
}

/** Whether the selection holds nothing. */
export const noParts = (parts: SelectionParts): boolean => parts.groups.length === 0 && parts.partial.length === 0 && parts.files.length === 0;

/** Pictures one by one, from every group, in calls of at most `FILES_PER_COMMAND`. */
const fileCalls = (parts: SelectionParts, command: (paths: string[]) => string): Chunk[] => {
  const all = parts.files.flatMap(({ group, paths }) => paths.map((path) => ({ group, path })));
  return chunks(all, FILES_PER_COMMAND).map((batch) => ({
    command: command(batch.map((each) => each.path)),
    groups: [],
    touched: [...new Set(batch.map((each) => each.group))],
    decides: 0,
    files: batch.length,
  }));
};

/** File the selection into the album at `album`: groups whole, groups but for some of theirs, then pictures one by one. */
export function fileChunks(parts: SelectionParts, album: string): Chunk[] {
  return [
    ...chunks(parts.groups, GROUPS_PER_COMMAND).map((groups) => ({
      command: commands.promoteInto(groups, album),
      groups,
      touched: [],
      decides: groups.length,
      files: members(groups),
    })),
    ...parts.partial.map(({ group, except }) => ({
      command: commands.promoteInto(group, album, except),
      groups: [],
      touched: [group],
      decides: 1,
      files: Math.max(0, (group.memberCount ?? 0) - except.length),
    })),
    ...fileCalls(parts, (paths) => commands.addFiles(album, paths)),
  ];
}

/**
 * Make the selection one new album titled `title`: the first call makes it, from the first groups
 * (or the first group but for some of its pictures), and `rest` files what is left into the album
 * that call made. None when the selection holds no group, whole or in part: pictures alone are
 * filed into an album that is there.
 */
export function newAlbumChunks<G extends GroupRef>(parts: SelectionParts<G>, title: string, privately: boolean): { first: Chunk; rest: SelectionParts<G> } | null {
  if (parts.groups.length > 0) {
    const groups = parts.groups.slice(0, GROUPS_PER_COMMAND);
    return {
      first: { command: commands.promoteNew(groups, title, { private: privately }), groups, touched: [], decides: groups.length, files: members(groups) },
      rest: { ...parts, groups: parts.groups.slice(GROUPS_PER_COMMAND) },
    };
  }
  const [first, ...partial] = parts.partial;
  if (!first) return null;
  return {
    first: {
      command: commands.promoteNew(first.group, title, { private: privately, except: first.except }),
      groups: [],
      touched: [first.group],
      decides: 1,
      files: Math.max(0, (first.group.memberCount ?? 0) - first.except.length),
    },
    rest: { ...parts, partial },
  };
}

/** Discard the selection: groups whole, groups but for some of theirs, then pictures one by one. */
export function discardChunks(parts: SelectionParts): Chunk[] {
  return [
    ...chunks(parts.groups, GROUPS_PER_COMMAND).map((groups) => ({
      command: commands.discardGroup(groups),
      groups,
      touched: [],
      decides: groups.length,
      files: members(groups),
    })),
    ...parts.partial.map(({ group, except }) => ({
      command: commands.discardGroup(group, except),
      groups: [],
      touched: [group],
      decides: 1,
      files: Math.max(0, (group.memberCount ?? 0) - except.length),
    })),
    ...fileCalls(parts, (paths) => commands.discardFiles(paths)),
  ];
}

/** Put the groups aside, or with `off` bring them back. Nothing moves, so they count no pictures. */
export const laterChunks = (groups: readonly GroupRef[], off: boolean): Chunk[] =>
  chunks(groups, LATER_PER_COMMAND).map((batch) => ({ command: commands.later(batch, off), groups: batch, touched: [], decides: batch.length, files: 0 }));

/** Apply the groups' proposals at least as sure as `confidence`. */
export const acceptChunks = (groups: readonly GroupRef[], confidence: 'high' | 'medium' | 'low'): Chunk[] =>
  chunks(groups, GROUPS_PER_COMMAND).map((batch) => ({
    command: commands.accept(batch, confidence),
    groups: batch,
    touched: [],
    decides: batch.length,
    files: members(batch),
  }));

/** What each group's proposal would file, whatever its confidence: the calls that read the plan. */
export const planCommands = (groups: readonly GroupRef[]): string[] => chunks(groups, PLAN_PER_COMMAND).map((batch) => commands.accept(batch, 'low', { dryRun: true }));

/**
 * Undo a run's journal entries, given in the order the run made them: newest first, at most
 * `UNDO_PER_COMMAND` a call, so what a later call filed is put back before what an earlier one did.
 */
export const undoCommands = (journal: readonly string[]): string[] => chunks([...journal].reverse(), UNDO_PER_COMMAND).map((ids) => commands.undoEntries(ids));

/**
 * The selection moved into the group `into`, as one drop on its header does it: groups whole are
 * merged into it, pictures (and groups but for some of theirs, as the pictures `itemsOf` knows of
 * them) move into it. Each is one call, which names `into` with its member key, so a drop of more
 * than one call's worth is refused; so is one of `into` itself, or of nothing.
 */
export function intoGroupChunks(
  parts: SelectionParts,
  into: GroupRef,
  itemsOf: (group: GroupRef) => readonly string[] | undefined,
): { chunk: Chunk } | { refused: string } {
  const groups = parts.groups.filter((group) => group.name !== into.name);
  const files = [
    ...parts.files.filter(({ group }) => group.name !== into.name).flatMap(({ paths }) => paths),
  ];
  for (const { group, except } of parts.partial) {
    if (group.name === into.name) continue;
    const items = itemsOf(group);
    if (!items) return { refused: `Select the pictures of “${group.title}” to move some of them` };
    const left = new Set(except);
    files.push(...items.filter((path) => !left.has(path)));
  }
  if (groups.length > 0 && files.length > 0) return { refused: 'Drop groups or pictures, not both at once' };
  if (groups.length > 0) {
    if (groups.length > GROUPS_PER_COMMAND) return { refused: `Merge at most ${GROUPS_PER_COMMAND} groups at a time` };
    return { chunk: { command: commands.merge(into, groups), groups, touched: [into], decides: groups.length, files: members(groups) } };
  }
  if (files.length === 0) return { refused: 'Already in this group' };
  if (files.length > REGROUP_PER_COMMAND) return { refused: `Move at most ${REGROUP_PER_COMMAND.toLocaleString('en')} pictures at a time` };
  const from = [...new Set([...parts.files.map(({ group }) => group), ...parts.partial.map(({ group }) => group)])].filter((group) => group.name !== into.name);
  return { chunk: { command: commands.regroupInto(into, files), groups: [], touched: [into, ...from], decides: 0, files: files.length } };
}
