/**
 * The one general command each decision and each edit of the groups on the Sort tab runs, as a
 * command line. Pure, so what is sent is tested without a page: groups are named by path with
 * their member key (`--expect`), so a group the organizer changed after it was drawn is refused
 * rather than filed or changed blind.
 */
import { shq } from '@ein/ui/lib';

/** A suggested group as a decision names it. */
type GroupRef = { path: string; staging: { memberKey: string } };

/** How sure a proposal must be for `staging accept` to file it. */
type Confidence = 'high' | 'medium' | 'low';

/** One group, or several. */
const listOf = (groups: GroupRef | readonly GroupRef[]): readonly GroupRef[] => 'path' in groups ? [groups] : groups;
const paths = (groups: readonly GroupRef[]) => groups.map((group) => shq(group.path)).join(' ');
/** One `--expect` per group, in the order the groups are named. */
const expect = (groups: readonly GroupRef[]) => groups.map((group) => `--expect ${shq(group.staging.memberKey)}`).join(' ');
const excepting = (except: readonly string[] = []) => except.map((path) => ` --except ${shq(path)}`).join('');

/** File the groups into the album at `album`, all but the members in `except`. */
export const promoteInto = (groups: GroupRef | readonly GroupRef[], album: string, except?: readonly string[]): string => {
  const list = listOf(groups);
  return `staging promote ${paths(list)} --into ${shq(album)}${excepting(except)} ${expect(list)}`;
};

/**
 * Make the groups one new album titled `title`, private when asked. With `except`, those members
 * stay in their group: the selected pictures go, the rest stay.
 */
export const promoteNew = (groups: GroupRef | readonly GroupRef[], title: string, options: { private?: boolean; except?: readonly string[] } = {}): string => {
  const list = listOf(groups);
  return `staging promote ${paths(list)} --name ${shq(title)}${options.private ? ' --share private' : ''}${excepting(options.except)} ${expect(list)}`;
};

/** Discard the groups whole, or one group but for the members in `except`. */
export const discardGroup = (groups: GroupRef | readonly GroupRef[], except?: readonly string[]): string => {
  const list = listOf(groups);
  return `staging discard ${paths(list)}${excepting(except)} ${expect(list)}`;
};

/** Apply the groups' proposals that are at least as sure as `confidence`; with `dryRun`, only say what each would get. */
export const accept = (groups: readonly GroupRef[], confidence: Confidence, options: { dryRun?: boolean } = {}): string =>
  `staging accept ${paths(groups)}${options.dryRun ? ' --dry-run' : ''} --confidence ${confidence} ${expect(groups)}`;

/** Discard staged files. */
export const discardFiles = (paths: readonly string[]): string => `staging discard ${paths.map(shq).join(' ')}`;

/** File staged files into the album at `album`. */
export const addFiles = (album: string, paths: readonly string[]): string => `album add ${shq(album)} ${paths.map(shq).join(' ')}`;

/** Put the groups aside, or bring them back. */
export const later = (groups: GroupRef | readonly GroupRef[], off: boolean): string => `staging later ${paths(listOf(groups))}${off ? ' --off' : ''}`;

/** Undo journal entries. */
export const undoEntries = (ids: readonly string[]): string => `staging undo ${ids.map(shq).join(' ')}`;

/** Split the group before `file`: it and the members after it become a new group. */
export const split = (group: GroupRef, file: string): string => `staging split ${shq(group.path)} --at ${shq(file)} ${expect([group])}`;

/** Move staged files into the group, from whichever groups hold them. */
export const regroupInto = (group: GroupRef, files: readonly string[]): string => `staging regroup ${shq(group.path)} ${files.map(shq).join(' ')} ${expect([group])}`;

/** Make staged files a new group of their own. */
export const regroupNew = (files: readonly string[]): string => `staging regroup --new ${files.map(shq).join(' ')}`;

/** Merge the others into `keep`, which keeps its name. */
export const merge = (keep: GroupRef, others: GroupRef | readonly GroupRef[]): string => {
  const list = [keep, ...(listOf(others))];
  return `staging merge ${paths(list)} ${expect(list)}`;
};

/** The group is no group: its members go back to their lanes. */
export const notAGroup = (group: GroupRef): string => `staging delete ${shq(group.path)} ${expect([group])}`;

/** The library album at `album` is not where the group goes: it is not offered for it again until the rejection is undone. */
export const reject = (group: GroupRef, album: string): string => `staging reject ${shq(group.path)} ${shq(album)}`;

/**
 * Resolve the duplicate sets `keys` of the group's members, keeping `keep` (a staged file's id) of
 * the one set named: the files they drop among the group's members go to the trash.
 */
export const dedupe = (group: GroupRef, keys: readonly string[], keep?: string): string =>
  `staging dedupe ${shq(group.path)} ${keys.map(shq).join(' ')}${keep ? ` --keep ${shq(keep)}` : ''}`;
