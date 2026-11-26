/**
 * What the Duplicates tab and the Sort stream say about duplicate sets and the commands they run,
 * as text and command lines: the tab's classes, a set's words, a suggested group's tile badges and
 * header count. Pure, so all of it is tested without a page.
 */
import type { DuplicateKeepRule, DuplicateKind, DuplicateMember, DuplicateSet, DuplicateWhere, MergeField } from '@archive/media/api';
import { parseStagedPath } from '@archive/staging/paths';
import { shq } from '@ein/ui/lib';

/** A class of findings as the tab shows it: its kind, where what they copy or look like lies, and what the tab calls it. */
export type DuplicateTab = { kind: DuplicateKind; where: DuplicateWhere; label: string };

/** The classes, in the order the tab shows them. */
export const DUPLICATE_TABS: DuplicateTab[] = [
  { kind: 'exact', where: 'library', label: 'Copies of library photos' },
  { kind: 'exact', where: 'inbox', label: 'Copies within this import' },
  { kind: 'near', where: 'library', label: 'Like library photos' },
  { kind: 'near', where: 'inbox', label: 'Alike within this import' },
];

/** The tab's key for a class. */
export const tabKey = (tab: { kind: DuplicateKind; where: DuplicateWhere }): string => `${tab.kind}:${tab.where}`;

/** Whether `--apply` can resolve any set of a class: copies, and look-alikes of library photos. */
export const bulkClass = (tab: { kind: DuplicateKind; where: DuplicateWhere }): boolean => tab.kind === 'exact' || tab.where === 'library';

/** Sets a page of the tab reads at once. */
const SETS_PER_PAGE = 30;

/** Copies one bulk call drops at most. */
const BULK_COPIES = 2_000;

/** Journal entries one `staging undo` takes at most. */
const UNDO_MAX = 20;

/** Why a file is kept, to follow "because". */
const KEEP_WORDS: Record<DuplicateKeepRule, string> = {
  library: 'it is already in the library',
  earliest: 'it arrived in staging first',
  chosen: 'you chose it',
  pixels: 'it has more pixels',
  format: 'its file format is better',
  capture: 'its date comes from a surer source',
  bytes: 'it is the larger file',
  name: 'its name has no copy mark such as “(1)”',
};

const FIELD_WORDS: Record<MergeField, string> = {
  description: 'description',
  time: 'time',
  place: 'place',
  labels: 'labels',
  star: 'star',
  sidecar: 'sidecar',
  faces: 'people',
  people: 'people',
  comments: 'comments',
  albums: 'albums',
};

/** Why the kept file is kept over `over` (any file when absent), after "because", with the numbers when the reason has them. */
const keepReason = (set: DuplicateSet, over?: string): string => {
  const reason = set.reasons.find((each) => each.over === over) ?? set.reasons[0];
  const rule = reason?.rule ?? (set.where === 'library' ? 'library' : 'earliest');
  return `${KEEP_WORDS[rule]}${reason?.detail ? ` (${reason.detail})` : ''}`;
};

/** The file `set` keeps, when it lists it. */
const keptMember = (set: DuplicateSet): DuplicateMember | undefined => [...set.existing, ...set.staged].find((member) => member.id === set.keep);

/** Which file a set keeps and why: "Keeps IMG_0001.jpg because it is already in the library". */
export const keepLine = (set: DuplicateSet): string => {
  const kept = keptMember(set);
  return `${kept ? `Keeps ${kept.name}` : 'Keeps one'} because ${keepReason(set)}`;
};

/** How alike a set's files are, as a percentage: "97% alike"; null for copies. */
export const scoreLine = (score: number | undefined): string | null => score === undefined ? null : `${Math.round(score * 100)}% alike`;

/** What a set's flags warn of, in words. */
export const flagLines = (set: DuplicateSet): string[] =>
  set.flags.flatMap((flag) =>
    flag === 'possible-burst'
      ? ['perhaps two shots of a burst: same size, same camera, same second']
      : flag === 'staged-larger'
      ? ['a staged one has more pixels than the library’s']
      : flag === 'outside-scope'
      ? ['files in other folders stay']
      : []
  );

/** What the kept file gains from the copies, in words, or null when nothing. */
export const gainsLine = (fields: MergeField[]): string | null => {
  const words = [...new Set(fields.map((field) => FIELD_WORDS[field]))];
  return words.length === 0 ? null : `the kept one gains: ${words.join(', ')}`;
};

/** Why a set is left out of bulk resolving, in words. */
export const blockedLine = (set: DuplicateSet): string | null => {
  if (set.blocked === 'keep-gone') return 'its original is gone or changed: nothing is dropped';
  if (set.blocked === 'keep-not-writable') return 'you cannot write the kept one, which would gain from the copies';
  if (set.blocked === 'changed') return 'it changed: look again';
  if (set.blocked === 'needs-review') return 'look-alikes are for you to look at: Remove all leaves them';
  return null;
};

/** `n copies`. */
export const copiesWord = (count: number): string => `${count.toLocaleString()} ${count === 1 ? 'copy' : 'copies'}`;

/** A page of one class's sets in `scope`. */
export const pageCommand = (scope: string, tab: { kind: DuplicateKind; where: DuplicateWhere }, cursor: string | null): string =>
  `staging duplicates ${shq(scope)} --${tab.kind} --where ${tab.where} --limit ${SETS_PER_PAGE}${cursor ? ` --cursor ${shq(cursor)}` : ''}`;

/** Resolve the sets `keys`, dropping their copies in `scope`; keeping `keep` (a staged file's id) of the one set named. */
export const resolveCommand = (scope: string, keys: readonly string[], keep?: string): string =>
  `staging dedupe ${shq(scope)} ${keys.map(shq).join(' ')}${keep ? ` --keep ${shq(keep)}` : ''}`;

/** One bulk call over a class of `scope`'s sets, from `cursor`. */
export const bulkCommand = (scope: string, tab: { kind: DuplicateKind; where: DuplicateWhere }, cursor: string | null): string =>
  `staging dedupe ${shq(scope)} --apply --${tab.kind} --where ${tab.where} --limit ${BULK_COPIES}${cursor ? ` --cursor ${shq(cursor)}` : ''}`;

/**
 * Record that a set's files are no duplicates: its anchor, the staged file it is keyed by, apart
 * from every other file it lists. Null for a set with no two files to keep apart.
 */
export const separateCommand = (set: DuplicateSet): string | null => {
  const anchorId = set.key.slice(set.key.indexOf(':') + 1);
  const members = [...set.staged, ...set.existing];
  const first = members.find((member) => member.id === anchorId) ?? set.staged[0];
  const rest = members.filter((member) => member.id !== first?.id).map((member) => member.path);
  return first && rest.length > 0 ? `staging separate ${shq(first.path)} ${rest.map(shq).join(' ')}` : null;
};

/** Every set of a suggested group's members, or of staged files (at most `FILE_SETS_READ`). */
export const setsCommand = (...paths: string[]): string => `staging duplicates ${paths.map(shq).join(' ')}`;

/** Staged files one `staging duplicates` takes at most. */
export const FILE_SETS_READ = 200;

/**
 * Where a set's file lies, in words: the library album holding it, or its folder in staging
 * ("Staged in phone/2024-06"); its full path says the rest.
 */
export const memberWhere = (member: DuplicateMember): string => {
  if (member.place === 'library') return member.album ? `In the album ${member.album.name}` : 'In the library';
  const parsed = parseStagedPath(member.path);
  if (parsed?.category === undefined) return 'Staged';
  const slash = parsed.rest.lastIndexOf('/');
  return `Staged in ${slash < 0 ? parsed.category : `${parsed.category}/${parsed.rest.slice(0, slash)}`}`;
};

/**
 * The paths resolving `set` keeping `keep` drops in the category at `category`, each staged file
 * with its byte copies: the set's own `discard` when `keep` is its kept file, else every other
 * staged file.
 */
export const droppedPaths = (set: DuplicateSet, keep: string, category: string): string[] => {
  const ids = new Set(keep === set.keep ? set.discard : set.staged.map((member) => member.id).filter((id) => id !== keep));
  return set.staged
    .filter((member) => ids.has(member.id))
    .flatMap((member) => [member.path, ...member.copies.map((copy) => copy.path)])
    .filter((path) => path.startsWith(`${category}/`));
};

/**
 * What a suggested group's sets say of keeping the library's copies: the sets of library photos
 * that resolve unasked, with how many of the group's pictures (`members`, by id) they drop — what
 * "Keep the library copies" does.
 */
export const groupDuplicates = (sets: readonly DuplicateSet[], members: ReadonlySet<string>): { library: { keys: string[]; files: number } } => {
  const keys: string[] = [];
  let files = 0;
  for (const set of sets) {
    const dropped = set.discard.filter((id) => members.has(id)).length;
    if (set.where === 'library' && set.bulk && dropped > 0) {
      keys.push(set.key);
      files += dropped;
    }
  }
  return { library: { keys, files } };
};

/** A tile's duplicate mark: how many files hold its bytes, itself included, and whether one of them is in the library. */
export type TileBadge = { files: number; library: boolean };

/**
 * What staged files' sets say of their tiles, by path: each staged file of a set of exact copies —
 * the one kept or a copy — is marked with how many files the set holds, and its set. Look-alikes
 * are not duplicates and mark nothing.
 */
export const fileDuplicates = (sets: readonly DuplicateSet[], paths: ReadonlySet<string>): {
  badges: Map<string, TileBadge>;
  setOf: Map<string, DuplicateSet>;
} => {
  const badges = new Map<string, TileBadge>();
  const setOf = new Map<string, DuplicateSet>();
  for (const set of sets) {
    if (set.kind !== 'exact') continue;
    const badge = { files: set.existing.length + set.staged.length, library: set.existing.length > 0 };
    for (const member of set.staged) {
      if (!paths.has(member.path) || badges.has(member.path)) continue;
      badges.set(member.path, badge);
      setOf.set(member.path, set);
    }
  }
  return { badges, setOf };
};

/** The `staging undo` lines that undo `ids`, newest first, as many entries as one takes each. */
export const undoCommands = (ids: readonly string[]): string[] => {
  const newest = [...ids].reverse();
  const lines: string[] = [];
  for (let i = 0; i < newest.length; i += UNDO_MAX) lines.push(`staging undo ${newest.slice(i, i + UNDO_MAX).map(shq).join(' ')}`);
  return lines;
};

/** `sets` without those whose keys are in `gone`. */
export const withoutSets = (sets: readonly DuplicateSet[], gone: ReadonlySet<string>): DuplicateSet[] => sets.filter((set) => !gone.has(set.key));

/** The sets of `next` not already in `held`, appended: a page read after a set resolved can repeat none, but a refetch may. */
export const appendSets = (held: readonly DuplicateSet[], next: readonly DuplicateSet[]): DuplicateSet[] => {
  const keys = new Set(held.map((set) => set.key));
  return [...held, ...next.filter((set) => !keys.has(set.key))];
};

/** How far a bulk run is, 0–100, from the copies dropped and the copies left. */
export const bulkPercent = (dropped: number, remaining: number | null): number => {
  if (remaining === null) return 0;
  const total = dropped + remaining;
  return total === 0 ? 100 : Math.round((dropped / total) * 100);
};

/** A set's files side by side in the compare dialog: the kept one first, then the others as the set lists them. */
export const compareMembers = (set: DuplicateSet): DuplicateSet['staged'] => {
  const all = [...set.existing, ...set.staged];
  return [...all.filter((member) => member.id === set.keep), ...all.filter((member) => member.id !== set.keep)];
};

/** What the compare dialog says of one file: its size in pixels and bytes, when it was taken, its camera, how alike it is. */
export const memberFacts = (member: DuplicateSet['staged'][number], formatBytes: (bytes: number) => string): string[] =>
  [
    member.width && member.height ? `${member.width}×${member.height}` : null,
    member.size !== undefined ? formatBytes(member.size) : null,
    member.takenAt ? member.takenAt.replace('T', ' ').slice(0, 19) : null,
    member.camera ? member.camera.split('/').pop() ?? null : null,
    scoreLine(member.score),
  ].filter((line): line is string => line !== null);

/** Where the compare dialog is: the file in focus, by index, and the one marked to keep, by id. */
export type CompareState = { focus: number; keep: string };

/**
 * What a key does in the compare dialog: ← and → move the focus, K keeps the file in focus (a
 * library file is always kept, so only a staged one can be chosen), Enter applies, X says the files
 * are not duplicates. Null for any other key.
 */
export const compareKey = (
  key: string,
  state: CompareState,
  members: readonly DuplicateSet['staged'][number][],
): { state: CompareState } | { apply: string } | { separate: true } | null => {
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const step = key === 'ArrowRight' ? 1 : -1;
    return { state: { ...state, focus: (state.focus + step + members.length) % members.length } };
  }
  const lower = key.toLowerCase();
  if (lower === 'k') {
    const member = members[state.focus];
    return member && member.place === 'inbox' ? { state: { ...state, keep: member.id } } : null;
  }
  if (key === 'Enter') return { apply: state.keep };
  if (lower === 'x') return { separate: true };
  return null;
};
