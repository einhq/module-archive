/**
 * The Sort tab's keys, in one table: what the page's one `keydown` listener acts on, what the `?`
 * overlay lists and what the docked legend shows are all read from it, so the three cannot drift
 * apart. Pure, so the table is tested without a page.
 *
 * A key acts in a scope: `group` while the cursor is on a group, `part` once `[` or `]` have put a
 * cursor on one of the open group's parts (a day, or a month in a long group), `tile` once the
 * arrows have put a cursor on one of its pictures, `selection` while pictures of it are selected,
 * `groups` while the selection reaches past the open group (other groups whole, or pictures of
 * them). A key a scope does not bind falls through, selection or part to tile to group, groups to
 * group, so J still moves on from a picture.
 */

export type TriageScope = 'group' | 'part' | 'tile' | 'selection' | 'groups';

export type TriageAction =
  | 'next'
  | 'previous'
  | 'extend-next'
  | 'extend-previous'
  | 'apply'
  | 'new'
  | 'private'
  | 'add-to'
  | 'target'
  | 'set-target'
  | 'discard'
  | 'later'
  | 'undo'
  | 'rename'
  | 'merge-up'
  | 'merge-down'
  | 'part-previous'
  | 'part-next'
  | 'split'
  | 'move-up'
  | 'move-down'
  | 'move-to'
  | 'date'
  | 'candidate-1'
  | 'candidate-2'
  | 'candidate-3'
  | 'candidate-previous'
  | 'candidate-next'
  | 'reject'
  | 'compare'
  | 'tile-left'
  | 'tile-right'
  | 'tile-up'
  | 'tile-down'
  | 'open'
  | 'select'
  | 'clear-selection'
  | 'leave';

/**
 * What a label may name: the group under the cursor and its neighbours in the stream, what Enter
 * does to it, the target B files into, how many pictures the keys act on (those selected, or the
 * part's), whether it is put aside, and whether it is a lane, where S makes a new group rather
 * than splits; across groups, how many groups the selection holds; the candidate albums 1, 2 and
 * 3 file into, the one highlighted (which R rejects), and whether the column is widened to compare.
 */
export type LegendContext = {
  title?: string;
  previous?: string;
  next?: string;
  proposal?: string;
  target?: string;
  selected?: number;
  later?: boolean;
  lane?: boolean;
  groups?: number;
  candidates?: readonly string[];
  candidate?: string;
  comparing?: boolean;
};

type TriageKey = {
  scope: TriageScope;
  /** As `useShortcutHelp` writes keys: a key's name or letter (`Enter`, `J`, `←`, `Esc`), `shift+` before it when held. */
  keys: string;
  action: TriageAction;
  label: (context: LegendContext) => string;
  /** Shown in the docked legend, not only in the `?` overlay. */
  legend?: boolean;
};

const quoted = (name: string | undefined, fallback: string) => (name ? `“${name}”` : fallback);
const pictures = (count: number | undefined) => count === undefined ? 'the pictures' : `${count} ${count === 1 ? 'picture' : 'pictures'}`;

/** Enter, N, P, A, B and X for some pictures of the group (those selected, or a part's) rather than all of it. */
const filing = (scope: 'selection' | 'part'): TriageKey[] => [
  {
    scope,
    keys: 'Enter',
    action: 'apply',
    label: ({ proposal, selected }) => proposal ? `${pictures(selected)}: ${proposal}` : 'No proposal: N, A, B or X',
    legend: true,
  },
  { scope, keys: 'N', action: 'new', label: ({ selected }) => `New album of ${pictures(selected)}`, legend: true },
  { scope, keys: 'P', action: 'private', label: ({ selected }) => `New private album of ${pictures(selected)}`, legend: true },
  { scope, keys: 'A', action: 'add-to', label: ({ selected }) => `Add ${pictures(selected)} to album…`, legend: true },
  {
    scope,
    keys: 'B',
    action: 'target',
    label: ({ target, selected }) => target ? `${pictures(selected)} into ${quoted(target, '')}` : 'Choose a target…',
    legend: true,
  },
  { scope, keys: 'X', action: 'discard', label: ({ selected }) => `Discard ${pictures(selected)}`, legend: true },
];

/** `<`, `>` and G: some pictures of the group into the group above, the one below, or any. */
const moves = (scope: 'selection' | 'part' | 'tile'): TriageKey[] => [
  { scope, keys: '<', action: 'move-up', label: ({ previous, selected }) => `Move ${pictures(selected)} to ${quoted(previous, 'the group above')}`, legend: true },
  { scope, keys: '>', action: 'move-down', label: ({ next, selected }) => `Move ${pictures(selected)} to ${quoted(next, 'the group below')}`, legend: true },
  { scope, keys: 'G', action: 'move-to', label: ({ selected }) => `Move ${pictures(selected)} to a group…`, legend: true },
];

const groupCount = (count: number | undefined) => count === undefined ? 'the groups' : `${count} ${count === 1 ? 'group' : 'groups'}`;

/** 1, 2 and 3: into the candidate album of that rank. */
const candidate = (n: 1 | 2 | 3): TriageKey => ({
  scope: 'group',
  keys: String(n),
  action: `candidate-${n}`,
  label: ({ candidates }) => candidates?.[n - 1] ? `Into “${candidates[n - 1]}”` : `Into candidate ${n}`,
  legend: n === 1,
});

/** What acts on a selection that reaches past the open group: the decisions over many groups at once. */
const acrossGroups: TriageKey[] = [
  { scope: 'groups', keys: 'Enter', action: 'apply', label: ({ groups }) => `Accept the proposals of ${groupCount(groups)}…`, legend: true },
  { scope: 'groups', keys: 'N', action: 'new', label: () => 'New album of the selection', legend: true },
  { scope: 'groups', keys: 'P', action: 'private', label: () => 'New private album of the selection', legend: true },
  { scope: 'groups', keys: 'A', action: 'add-to', label: () => 'Add the selection to album…', legend: true },
  { scope: 'groups', keys: 'B', action: 'target', label: ({ target }) => target ? `The selection into ${quoted(target, '')}` : 'Choose a target…', legend: true },
  { scope: 'groups', keys: 'X', action: 'discard', label: () => 'Discard the selection…', legend: true },
  {
    scope: 'groups',
    keys: 'L',
    action: 'later',
    label: ({ later, groups }) => later ? `${groupCount(groups)} back to their lanes` : `Later, ${groupCount(groups)}`,
    legend: true,
  },
  { scope: 'groups', keys: 'Esc', action: 'clear-selection', label: () => 'Clear the selection', legend: true },
];

export const TRIAGE_KEYS: readonly TriageKey[] = [
  { scope: 'group', keys: 'Enter', action: 'apply', label: ({ proposal }) => proposal ?? 'No proposal: N, A, B or X', legend: true },
  { scope: 'group', keys: 'N', action: 'new', label: ({ title }) => `New album ${quoted(title, 'from this group')}`, legend: true },
  { scope: 'group', keys: 'P', action: 'private', label: () => 'New private album', legend: true },
  { scope: 'group', keys: 'A', action: 'add-to', label: () => 'Add to album…', legend: true },
  { scope: 'group', keys: 'B', action: 'target', label: ({ target }) => target ? `Into ${quoted(target, '')}` : 'Choose a target…', legend: true },
  { scope: 'group', keys: 'shift+B', action: 'set-target', label: () => 'Choose the target' },
  { scope: 'group', keys: 'X', action: 'discard', label: () => 'Discard', legend: true },
  { scope: 'group', keys: 'L', action: 'later', label: ({ later }) => later ? 'Back to its lane' : 'Later', legend: true },
  { scope: 'group', keys: 'Z', action: 'undo', label: () => 'Undo', legend: true },
  { scope: 'group', keys: 'J', action: 'next', label: () => 'Next group', legend: true },
  { scope: 'group', keys: 'K', action: 'previous', label: () => 'Previous group', legend: true },
  { scope: 'group', keys: 'shift+J', action: 'extend-next', label: () => 'Select on to the next group' },
  { scope: 'group', keys: 'shift+K', action: 'extend-previous', label: () => 'Select on to the previous group' },
  { scope: 'group', keys: 'shift+↓', action: 'extend-next', label: () => 'Select on to the next group' },
  { scope: 'group', keys: 'shift+↑', action: 'extend-previous', label: () => 'Select on to the previous group' },
  { scope: 'group', keys: 'E', action: 'rename', label: () => 'Rename' },
  { scope: 'group', keys: 'T', action: 'date', label: ({ selected }) => selected ? `Set the time of ${pictures(selected)}` : 'Set the time of every picture' },
  { scope: 'group', keys: '[', action: 'part-previous', label: () => 'Previous day or month of the group' },
  { scope: 'group', keys: ']', action: 'part-next', label: () => 'Next day or month of the group' },
  candidate(1),
  candidate(2),
  candidate(3),
  { scope: 'group', keys: 'R', action: 'reject', label: ({ candidate }) => `Not ${quoted(candidate, 'this album')}`, legend: true },
  { scope: 'group', keys: ',', action: 'candidate-previous', label: () => 'Highlight the candidate above' },
  { scope: 'group', keys: '.', action: 'candidate-next', label: () => 'Highlight the candidate below' },
  { scope: 'group', keys: 'C', action: 'compare', label: ({ comparing }) => comparing ? 'Narrow the column' : 'Compare with the highlighted album' },
  { scope: 'group', keys: 'M', action: 'merge-up', label: ({ previous }) => `Merge into ${quoted(previous, 'the group above')}` },
  { scope: 'group', keys: 'shift+M', action: 'merge-down', label: ({ next }) => `Merge ${quoted(next, 'the group below')} in` },
  { scope: 'group', keys: 'O', action: 'open', label: () => 'Open the first picture' },
  { scope: 'group', keys: '←', action: 'tile-left', label: () => 'Step through the pictures' },
  { scope: 'group', keys: '→', action: 'tile-right', label: () => 'Step through the pictures' },
  { scope: 'group', keys: '↑', action: 'tile-up', label: () => 'Step through the pictures' },
  { scope: 'group', keys: '↓', action: 'tile-down', label: () => 'Step through the pictures' },
  { scope: 'tile', keys: '←', action: 'tile-left', label: () => 'Previous picture' },
  { scope: 'tile', keys: '→', action: 'tile-right', label: () => 'Next picture' },
  { scope: 'tile', keys: '↑', action: 'tile-up', label: () => 'Picture above' },
  { scope: 'tile', keys: '↓', action: 'tile-down', label: () => 'Picture below' },
  { scope: 'tile', keys: 'Space', action: 'select', label: () => 'Select the picture', legend: true },
  { scope: 'tile', keys: 'O', action: 'open', label: () => 'Open the picture', legend: true },
  {
    scope: 'tile',
    keys: 'S',
    action: 'split',
    label: ({ lane }) => lane ? 'New group of this picture' : 'Split the group before this picture',
    legend: true,
  },
  ...moves('tile'),
  { scope: 'tile', keys: 'Esc', action: 'leave', label: () => 'Back to the group', legend: true },
  ...filing('part'),
  { scope: 'part', keys: 'Space', action: 'select', label: () => 'Select its pictures', legend: true },
  {
    scope: 'part',
    keys: 'S',
    action: 'split',
    label: ({ lane, selected }) => lane ? `New group of ${pictures(selected)}` : 'Split the group before it',
    legend: true,
  },
  ...moves('part'),
  { scope: 'part', keys: 'Esc', action: 'leave', label: () => 'Back to the group', legend: true },
  ...filing('selection'),
  {
    scope: 'selection',
    keys: 'S',
    action: 'split',
    label: ({ lane, selected }) => lane ? `New group of ${pictures(selected)}` : 'Split the group before the first selected',
    legend: true,
  },
  ...moves('selection'),
  { scope: 'selection', keys: 'Esc', action: 'clear-selection', label: () => 'Clear the selection', legend: true },
  ...acrossGroups,
];

/** The keys the table writes as they are printed, by the name a key event gives them. */
const EVENT_KEY: Record<string, string> = { '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown', Esc: 'Escape', Space: ' ' };

/**
 * `shift+M` as the key event it stands for. Letters compare without case: the Shift key, not the
 * letter's case, says which is meant.
 */
export const parseKeys = (keys: string): { key: string; shift: boolean } => {
  const parts = keys.split('+').map((part) => part.trim());
  const written = parts.pop() ?? '';
  const key = EVENT_KEY[written] ?? written;
  return { key: key.length === 1 ? key.toLowerCase() : key, shift: parts.some((part) => part.toLowerCase() === 'shift') };
};

/** What a key event says, as the table compares it. */
type KeyPress = { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean };

const pressed = (event: KeyPress) => ({ key: event.key.length === 1 ? event.key.toLowerCase() : event.key, shift: event.shiftKey });

/**
 * A key that types a sign rather than a letter or a digit (`<`, `[`). The sign alone says which
 * is meant, whatever Shift, Alt or AltGr the reader's keyboard needs to type it.
 */
const isSign = (key: string): boolean => key.length === 1 && !/[\p{L}\p{N}\s]/u.test(key);

const bindsIn = (scope: TriageScope, event: KeyPress): TriageKey | undefined => {
  const { key, shift } = pressed(event);
  return TRIAGE_KEYS.find((entry) => {
    if (entry.scope !== scope) return false;
    const bound = parseKeys(entry.keys);
    return bound.key === key && (isSign(key) || bound.shift === shift);
  });
};

/** The scopes a key pressed in `scope` is looked up in, in order. */
const FALL_THROUGH: Record<TriageScope, TriageScope[]> = {
  groups: ['groups', 'group'],
  selection: ['selection', 'tile', 'group'],
  part: ['part', 'tile', 'group'],
  tile: ['tile', 'group'],
  group: ['group'],
};

/**
 * The table's entry for a key pressed in `scope`, falling through to the scopes under it. None
 * with Cmd held, nor with Alt or Ctrl but for a sign typed with AltGr (Ctrl and Alt) or Option.
 */
export function matchTriageKey(event: KeyPress, scope: TriageScope): TriageKey | undefined {
  if (event.metaKey) return undefined;
  if (isSign(event.key) ? event.ctrlKey && !event.altKey : event.altKey || event.ctrlKey) return undefined;
  for (const each of FALL_THROUGH[scope]) {
    const entry = bindsIn(each, event);
    if (entry) return entry;
  }
  return undefined;
}

/** What a key's target is, as far as the guard asks: an element, or something like one. */
export type KeyTarget = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };

/** What else is on screen that would own a key. */
type GuardContext = { lightboxOpen: boolean; dialogOpen: boolean; modalOpen: boolean };

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Controls that Enter and Space press: a focused one keeps them. */
const PRESSED_BY_ENTER = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"]';
/** Controls the arrow keys move within: a focused one keeps them. */
const MOVED_BY_ARROWS = '[role="tab"], [role="tablist"], [role="radio"], [role="radiogroup"], [role="slider"]';

/**
 * Whether the stream may act on `key` at all: not while the lightbox, the shell's dialog or one of
 * the page's own dialogs is open, and not when the key goes to a field, an editable element, a
 * menu or a list box. Enter or Space on a focused button or link, and an arrow on a focused tab, are
 * the control's own; every other key still reaches the stream from there.
 */
export function keysAllowed(target: KeyTarget | null, context: GuardContext, key: string): boolean {
  if (context.lightboxOpen || context.dialogOpen || context.modalOpen) return false;
  if (!target) return true;
  if (target.tagName && TYPING_TAGS.has(target.tagName.toUpperCase())) return false;
  if (target.isContentEditable) return false;
  if (target.closest?.('[role="menu"], [role="listbox"], [contenteditable="true"]')) return false;
  if ((key === 'Enter' || key === ' ') && target.closest?.(PRESSED_BY_ENTER)) return false;
  if (key.startsWith('Arrow') && target.closest?.(MOVED_BY_ARROWS)) return false;
  return true;
}

/** The legend's entries for `scope`: those marked for it, then those of the scopes it falls through to, each key once. */
export function legendEntries(scope: TriageScope, context: LegendContext): { keys: string; label: string; action: TriageAction }[] {
  const entries: TriageKey[] = [];
  for (const each of FALL_THROUGH[scope]) {
    for (const entry of TRIAGE_KEYS) {
      if (entry.scope === each && entry.legend && !entries.some((mine) => mine.keys === entry.keys)) entries.push(entry);
    }
  }
  return entries.map((entry) => ({ keys: entry.keys, label: entry.label(context), action: entry.action }));
}

/**
 * The keys as the `?` overlay lists them: each key once, under its group-scope label (a key the
 * group scope does not bind under the first the table gives it), and the keys that share a label
 * in one row (`← → ↑ ↓`).
 */
export const TRIAGE_HELP: readonly { keys: string; label: string }[] = (() => {
  const rows: { keys: string[]; label: string }[] = [];
  const listed = new Set<string>();
  for (const entry of TRIAGE_KEYS) {
    if (listed.has(entry.keys)) continue;
    listed.add(entry.keys);
    const label = entry.label({});
    const row = rows.find((each) => each.label === label);
    if (row) row.keys.push(entry.keys);
    else rows.push({ keys: [entry.keys], label });
  }
  return rows.map((row) => ({ keys: row.keys.join(' '), label: row.label }));
})();
