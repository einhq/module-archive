import { assert, assertEquals } from '@std/assert';
import { keysAllowed, legendEntries, matchTriageKey, parseKeys, TRIAGE_HELP, TRIAGE_KEYS, type TriageScope } from '../triage-keys.ts';

const press = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

/** The key event a table entry is bound to. */
const eventFor = (keys: string) => {
  const { key, shift } = parseKeys(keys);
  return press(shift && key.length === 1 ? key.toUpperCase() : key, { shiftKey: shift });
};

const OPEN = { lightboxOpen: false, dialogOpen: false, modalOpen: false };

Deno.test('no key is bound twice in a scope', () => {
  for (const scope of ['group', 'part', 'tile', 'selection', 'groups'] as TriageScope[]) {
    const bound = TRIAGE_KEYS.filter((entry) => entry.scope === scope).map((entry) => JSON.stringify(parseKeys(entry.keys)));
    assertEquals(bound.length, new Set(bound).size, `a key bound twice in ${scope}`);
  }
});

Deno.test('every legend entry is bound, in the scope it is shown in', () => {
  for (const scope of ['group', 'part', 'tile', 'selection', 'groups'] as TriageScope[]) {
    const entries = legendEntries(scope, { title: 'Lake weekend', previous: 'Midsummer eve', next: 'Monday', selected: 3 });
    assert(entries.length > 0);
    for (const entry of entries) assertEquals(matchTriageKey(eventFor(entry.keys), scope)?.action, entry.action, `${entry.keys} in ${scope}`);
  }
  // Labels name what is on screen.
  const context = { title: 'Lake weekend', proposal: 'Add to “Lake trip 2019”', target: 'Summer 2019', selected: 3 };
  const labels = legendEntries('group', context).map((entry) => entry.label);
  assert(labels.includes('New album “Lake weekend”'));
  assert(labels.includes('Add to “Lake trip 2019”'));
  assert(labels.includes('Into “Summer 2019”'));
  const selected = legendEntries('selection', context).map((entry) => entry.label);
  assert(selected.includes('Discard 3 pictures'));
  assert(selected.includes('3 pictures into “Summer 2019”'));
  // A group without a proposal says what is left.
  assertEquals(legendEntries('group', {}).find((entry) => entry.action === 'apply')?.label, 'No proposal: N, A, B or X');
});

Deno.test("nothing clashes with the shell's keys: mod+K, ?, and Alt with anything", () => {
  for (const scope of ['group', 'part', 'tile', 'selection', 'groups'] as TriageScope[]) {
    assertEquals(matchTriageKey(press('k', { ctrlKey: true }), scope), undefined);
    assertEquals(matchTriageKey(press('k', { metaKey: true }), scope), undefined);
    assertEquals(matchTriageKey(press('?', { shiftKey: true }), scope), undefined);
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') assertEquals(matchTriageKey(press(letter, { altKey: true }), scope), undefined);
  }
  assert(TRIAGE_KEYS.every((entry) => !/^(mod|alt|ctrl)\+/i.test(entry.keys)));
});

Deno.test('Shift, not the letter case, tells M from shift+M; the tile scope falls through to the group', () => {
  assertEquals(matchTriageKey(press('m'), 'group')?.action, 'merge-up');
  assertEquals(matchTriageKey(press('M', { shiftKey: true }), 'group')?.action, 'merge-down');
  // Caps Lock types a capital without Shift.
  assertEquals(matchTriageKey(press('M'), 'group')?.action, 'merge-up');
  assertEquals(matchTriageKey(press('j'), 'tile')?.action, 'next');
  assertEquals(matchTriageKey(press('ArrowLeft'), 'tile')?.action, 'tile-left');
  assertEquals(matchTriageKey(press('Escape'), 'tile')?.action, 'leave');
  assertEquals(matchTriageKey(press('Escape'), 'group'), undefined);
  assertEquals(matchTriageKey(press('q'), 'group'), undefined);
  // A selection takes N, X and Esc for itself; J still moves on.
  assertEquals(matchTriageKey(press('x'), 'group')?.action, 'discard');
  assertEquals(matchTriageKey(press('Escape'), 'selection')?.action, 'clear-selection');
  assertEquals(matchTriageKey(press(' '), 'selection')?.action, 'select');
  assertEquals(matchTriageKey(press('j'), 'selection')?.action, 'next');
  assertEquals(matchTriageKey(press('B', { shiftKey: true }), 'group')?.action, 'set-target');
});

Deno.test('a part takes the filing keys, S and the moves for its pictures; the rest falls through', () => {
  assertEquals(matchTriageKey(press('Enter'), 'part')?.scope, 'part');
  assertEquals(matchTriageKey(press('x'), 'part')?.scope, 'part');
  assertEquals(matchTriageKey(press('s'), 'part')?.action, 'split');
  assertEquals(matchTriageKey(press(' '), 'part')?.scope, 'part');
  assertEquals(matchTriageKey(press('Escape'), 'part')?.action, 'leave');
  assertEquals(matchTriageKey(press('j'), 'part')?.action, 'next');
  assertEquals(matchTriageKey(press('ArrowRight'), 'part')?.action, 'tile-right');
  assertEquals(matchTriageKey(press(']'), 'part')?.action, 'part-next');
  // S, the moves and G need some pictures: a tile, a part or a selection, not the whole group.
  for (const key of ['s', '<', '>', 'g']) assertEquals(matchTriageKey(press(key), 'group'), undefined);
  assertEquals(matchTriageKey(press('g'), 'tile')?.action, 'move-to');
  assertEquals(matchTriageKey(press('s'), 'selection')?.action, 'split');
  assertEquals(matchTriageKey(press('t'), 'selection')?.action, 'date');
});

Deno.test('a sign is matched as typed, whatever Shift, AltGr or Option it took', () => {
  // `>` is Shift and the key left of Z on a Swedish keyboard, Shift and the period on an American one.
  assertEquals(matchTriageKey(press('>', { shiftKey: true }), 'tile')?.action, 'move-down');
  assertEquals(matchTriageKey(press('<'), 'tile')?.action, 'move-up');
  // `[` is AltGr+8 (Ctrl and Alt on Windows) or Option+8 on a Mac.
  assertEquals(matchTriageKey(press('[', { ctrlKey: true, altKey: true }), 'group')?.action, 'part-previous');
  assertEquals(matchTriageKey(press(']', { altKey: true }), 'group')?.action, 'part-next');
  // Ctrl alone, or Cmd, is still someone else's.
  assertEquals(matchTriageKey(press('[', { ctrlKey: true }), 'group'), undefined);
  assertEquals(matchTriageKey(press('[', { metaKey: true }), 'group'), undefined);
});

Deno.test('in a lane, S makes a new group rather than splits; the moves name the neighbours', () => {
  const labels = (scope: TriageScope, context: Parameters<typeof legendEntries>[1]) =>
    Object.fromEntries(legendEntries(scope, context).map((entry) => [entry.keys, entry.label]));
  assertEquals(labels('selection', { selected: 4 }).S, 'Split the group before the first selected');
  assertEquals(labels('selection', { selected: 4, lane: true }).S, 'New group of 4 pictures');
  assertEquals(labels('part', { selected: 12, previous: 'Midsummer eve' })['<'], 'Move 12 pictures to “Midsummer eve”');
  assertEquals(labels('tile', { selected: 1 })['>'], 'Move 1 picture to the group below');
});

Deno.test('the guard is off with the lightbox, a dialog or a page modal open, and in fields and menus', () => {
  assert(keysAllowed(null, OPEN, 'j'));
  assert(keysAllowed({ tagName: 'DIV', closest: () => null }, OPEN, 'Enter'));
  assertEquals(keysAllowed(null, { ...OPEN, lightboxOpen: true }, 'j'), false);
  assertEquals(keysAllowed(null, { ...OPEN, dialogOpen: true }, 'j'), false);
  assertEquals(keysAllowed(null, { ...OPEN, modalOpen: true }, 'j'), false);
  assertEquals(keysAllowed({ tagName: 'INPUT' }, OPEN, 'j'), false);
  assertEquals(keysAllowed({ tagName: 'textarea' }, OPEN, 'j'), false);
  assertEquals(keysAllowed({ tagName: 'DIV', isContentEditable: true }, OPEN, 'j'), false);
  assertEquals(keysAllowed({ tagName: 'BUTTON', closest: (selector) => selector.includes('menu') ? {} : null }, OPEN, 'j'), false);
});

/** An element as `closest` sees it: matched by tag or role, the way `Element.closest` would. */
const element = (tagName: string, role?: string) => ({
  tagName,
  closest: (selector: string) =>
    selector.split(',').map((part) => part.trim()).some((part) => part === tagName.toLowerCase() || (role !== undefined && part === `[role="${role}"]`)) ? {} : null,
});

Deno.test("Enter on a focused button or link, and an arrow on a focused tab, are the control's own", () => {
  // Retry, Dismiss, the toast's Open album, the ⋯ trigger: Enter presses them.
  assertEquals(keysAllowed(element('BUTTON'), OPEN, 'Enter'), false);
  assertEquals(keysAllowed(element('DIV', 'button'), OPEN, 'Enter'), false);
  // The page's tabs move with the arrows, and Enter selects one.
  assertEquals(keysAllowed(element('BUTTON', 'tab'), OPEN, 'ArrowRight'), false);
  assertEquals(keysAllowed(element('BUTTON', 'tab'), OPEN, 'Enter'), false);
  // Every other key still reaches the stream from there.
  assert(keysAllowed(element('BUTTON'), OPEN, 'j'));
  assert(keysAllowed(element('BUTTON'), OPEN, 'ArrowRight'));
  assert(keysAllowed(element('BUTTON', 'tab'), OPEN, 'j'));
});

Deno.test('the overlay lists every bound key, each once', () => {
  const listed = TRIAGE_HELP.flatMap((entry) => entry.keys.split(' '));
  assertEquals(listed.length, new Set(listed).size);
  for (const entry of TRIAGE_KEYS) assert(listed.includes(entry.keys), `${entry.keys} is not listed`);
  // The arrows share one row.
  assertEquals(TRIAGE_HELP.find((entry) => entry.label === 'Step through the pictures')?.keys, '← → ↑ ↓');
});

Deno.test('across groups, the filing keys act on the selection, and Shift with J, K or an arrow selects on to the next group', () => {
  assertEquals(matchTriageKey(press('Enter'), 'groups')?.label({ groups: 12 }), 'Accept the proposals of 12 groups…');
  assertEquals(matchTriageKey(press('l'), 'groups')?.label({ groups: 3, later: true }), '3 groups back to their lanes');
  assertEquals(matchTriageKey(press('j'), 'groups')?.action, 'next');
  assertEquals(matchTriageKey(press('J', { shiftKey: true }), 'group')?.action, 'extend-next');
  assertEquals(matchTriageKey(press('ArrowUp', { shiftKey: true }), 'group')?.action, 'extend-previous');
  // From a picture, Shift and an arrow falls through to the groups.
  assertEquals(matchTriageKey(press('ArrowDown', { shiftKey: true }), 'tile')?.action, 'extend-next');
  assertEquals(matchTriageKey(press('ArrowDown'), 'tile')?.action, 'tile-down');
});

Deno.test('1, 2 and 3 file into the candidates, R rejects the highlighted one, comma and full stop move it, C compares', () => {
  assertEquals(['1', '2', '3'].map((key) => matchTriageKey(press(key), 'group')?.action), ['candidate-1', 'candidate-2', 'candidate-3']);
  assertEquals(matchTriageKey(press('r'), 'group')?.action, 'reject');
  assertEquals(matchTriageKey(press(','), 'group')?.action, 'candidate-previous');
  assertEquals(matchTriageKey(press('.'), 'group')?.action, 'candidate-next');
  assertEquals(matchTriageKey(press('c'), 'group')?.action, 'compare');
  // From a picture or a selection they reach the group's candidates too.
  assertEquals(matchTriageKey(press('2'), 'selection')?.action, 'candidate-2');
  const labels = legendEntries('group', { candidates: ['Lake trip 2019', 'Summer 2019'], candidate: 'Summer 2019' });
  assert(labels.some((entry) => entry.keys === '1' && entry.label === 'Into “Lake trip 2019”'));
  assert(labels.some((entry) => entry.keys === 'R' && entry.label === 'Not “Summer 2019”'));
});
