import type { DuplicateSet } from '@archive/media/api';
import { assertEquals } from '@std/assert';
import {
  appendSets,
  blockedLine,
  bulkClass,
  bulkCommand,
  bulkPercent,
  compareKey,
  compareMembers,
  copiesWord,
  droppedPaths,
  DUPLICATE_TABS,
  fileDuplicates,
  fileSetLine,
  flagLines,
  gainsLine,
  groupDuplicates,
  keepLine,
  memberFacts,
  pageCommand,
  resolveCommand,
  scoreLine,
  separateCommand,
  setsCommand,
  undoCommands,
  withoutSets,
} from '../duplicate-sets.ts';

const SCOPE = '/home/anna/staging/files/inbox';

const set = (key: string, more: Partial<DuplicateSet> = {}): DuplicateSet => ({
  key,
  kind: 'exact',
  where: 'library',
  sha256: 'a'.repeat(64),
  keep: 'k',
  discard: ['d'],
  staged: [],
  existing: [],
  reasons: [{ rule: 'library', keep: 'k', over: 'd' }],
  carries: [],
  reclaimableBytes: 0,
  flags: [],
  bulk: true,
  ...more,
});

Deno.test('a set is said in words: why its file is kept, what it gains, what blocks it', () => {
  assertEquals(keepLine(set('exact:a')), 'kept: it is in the library');
  assertEquals(keepLine(set('exact:a', { where: 'inbox', reasons: [{ rule: 'earliest', keep: 'k', over: 'd' }] })), 'kept: it came first');
  assertEquals(keepLine(set('exact:a', { reasons: [{ rule: 'chosen', keep: 'k', over: 'd' }] })), 'kept: you chose it');
  assertEquals(gainsLine([]), null);
  assertEquals(gainsLine(['description', 'faces', 'people']), 'the kept one gains: description, people');
  assertEquals(blockedLine(set('exact:a')), null);
  assertEquals(blockedLine(set('exact:a', { blocked: 'keep-gone' })), 'its original is gone or changed: nothing is dropped');
  assertEquals([copiesWord(1), copiesWord(2_000)], ['1 copy', `${(2_000).toLocaleString()} copies`]);
});

Deno.test('the commands name the scope, the class, the sets and the cursor', () => {
  const q = `'${SCOPE}'`;
  const exactInbox = { kind: 'exact', where: 'inbox' } as const;
  const exactLibrary = { kind: 'exact', where: 'library' } as const;
  assertEquals(pageCommand(SCOPE, exactInbox, null), `staging duplicates ${q} --exact --where inbox --limit 30`);
  assertEquals(pageCommand(SCOPE, exactLibrary, 'exact:library:01J'), `staging duplicates ${q} --exact --where library --limit 30 --cursor 'exact:library:01J'`);
  assertEquals(pageCommand(SCOPE, { kind: 'near', where: 'library' }, null), `staging duplicates ${q} --near --where library --limit 30`);
  assertEquals(resolveCommand(SCOPE, ['exact:01J']), `staging dedupe ${q} 'exact:01J'`);
  assertEquals(resolveCommand(SCOPE, ['exact:01J'], '01K'), `staging dedupe ${q} 'exact:01J' --keep '01K'`);
  assertEquals(bulkCommand(`${SCOPE}/it's`, exactLibrary, null), `staging dedupe '${SCOPE}/it'\\''s' --apply --exact --where library --limit 2000`);
  assertEquals(bulkCommand(SCOPE, exactInbox, 'exact:inbox:01J'), `staging dedupe ${q} --apply --exact --where inbox --limit 2000 --cursor 'exact:inbox:01J'`);
  assertEquals(setsCommand(`${SCOPE}/a.jpg`, `${SCOPE}/b.jpg`), `staging duplicates '${SCOPE}/a.jpg' '${SCOPE}/b.jpg'`);
});

Deno.test('undo takes the newest entries first, at most 20 a line', () => {
  const ids = Array.from({ length: 23 }, (_, i) => `E${String(i).padStart(2, '0')}`);
  const lines = undoCommands(ids);
  assertEquals(lines.length, 2);
  assertEquals(lines[0].startsWith("staging undo 'E22' 'E21'"), true);
  assertEquals(lines[1], "staging undo 'E02' 'E01' 'E00'");
  assertEquals(undoCommands([]), []);
});

Deno.test('a list of sets drops what is resolved and never repeats a set', () => {
  const held = [set('exact:a'), set('exact:b')];
  assertEquals(withoutSets(held, new Set(['exact:a'])).map((each) => each.key), ['exact:b']);
  assertEquals(appendSets(held, [set('exact:b'), set('exact:c')]).map((each) => each.key), ['exact:a', 'exact:b', 'exact:c']);
});

Deno.test("a bulk run's progress", () => {
  assertEquals([bulkPercent(0, null), bulkPercent(0, 0), bulkPercent(50, 150), bulkPercent(200, 0)], [0, 100, 25, 100]);
});

Deno.test('four classes: copies and look-alikes, of library photos and within the import; look-alikes within it never resolve unasked', () => {
  assertEquals(DUPLICATE_TABS.map((tab) => `${tab.kind}:${tab.where}`), ['exact:library', 'exact:inbox', 'near:library', 'near:inbox']);
  assertEquals(DUPLICATE_TABS.map(bulkClass), [true, true, true, false]);
});

const member = (id: string, more: Partial<DuplicateSet['staged'][number]> = {}): DuplicateSet['staged'][number] => ({
  id,
  path: `${SCOPE}/${id}.jpg`,
  name: `${id}.jpg`,
  place: 'inbox',
  inScope: true,
  previewPath: `${SCOPE}/${id}.jpg`,
  thumbnails: true,
  carries: [],
  copies: [],
  ...more,
});

Deno.test('a set of look-alikes says how alike, why, and what to look out for', () => {
  const near = set('near:a', {
    kind: 'near',
    score: 0.968,
    flags: ['possible-burst', 'outside-scope'],
    reasons: [{ rule: 'pixels', keep: 'k', over: 'd', detail: '4032×3024 over 2048×1536' }],
  });
  assertEquals(scoreLine(near.score), '97% alike');
  assertEquals(scoreLine(undefined), null);
  assertEquals(keepLine(near), 'kept: it has more pixels (4032×3024 over 2048×1536)');
  assertEquals(flagLines(near), ['perhaps two shots of a burst: same size, same camera, same second', 'files in other folders stay']);
  assertEquals(blockedLine(set('near:a', { blocked: 'needs-review' })), 'look-alikes are for you to look at: Remove all leaves them');
  assertEquals(
    memberFacts(member('d', { width: 2048, height: 1536, size: 1_000, takenAt: '2021-07-04T12:15:30', device: '/devices/camera-a', score: 0.97 }), (bytes) => `${bytes} B`),
    ['2048×1536', '1000 B', '2021-07-04 12:15:30', 'camera-a', '97% alike'],
  );
});

Deno.test("a group's sets give its tiles badges, a library badge first, and what keeping the library's copies drops", () => {
  const library = set('near:a', { kind: 'near', where: 'library', discard: ['a', 'x'], bulk: true });
  const within = set('exact:b', { where: 'inbox', discard: ['a', 'b'], bulk: true });
  const review = set('near:c', { kind: 'near', where: 'library', discard: ['c'], bulk: false, blocked: 'needs-review' });
  const view = groupDuplicates([within, library, review], new Set(['a', 'b', 'c']));
  assertEquals([...view.badges].sort(), [['a', 'library'], ['b', 'inbox'], ['c', 'library']]);
  assertEquals(view.setOf.get('a')?.key, 'near:a');
  assertEquals(view.library, { keys: ['near:a'], files: 1 }, 'a member it drops; a set for a person to look at is left');
});

Deno.test('staged files badged by path, one kept over its copies too, a library badge still first', () => {
  const staged = (...ids: string[]) => ids.map((id) => ({ id, path: `${SCOPE}/${id}.jpg` })) as DuplicateSet['staged'];
  const within = set('exact:k', { where: 'inbox', keep: 'k', discard: ['c'], staged: staged('k', 'c') });
  const library = set('exact:l', { keep: 'l', discard: ['k'], staged: staged('k') });
  const alone = set('near:m', { kind: 'near', where: 'inbox', keep: 'm', discard: [], staged: staged('m') });
  const view = fileDuplicates([within, alone], new Set([`${SCOPE}/k.jpg`, `${SCOPE}/m.jpg`]));
  assertEquals([...view.badges], [[`${SCOPE}/k.jpg`, 'inbox']]);
  assertEquals(view.setOf.get(`${SCOPE}/k.jpg`), within);
  assertEquals([...fileDuplicates([within, library], new Set([`${SCOPE}/k.jpg`])).badges], [[`${SCOPE}/k.jpg`, 'library']]);
});

Deno.test('the compare dialog: arrows move, K keeps a staged file, Enter applies, X keeps them apart', () => {
  const compared = set('near:a', { kind: 'near', keep: 'l', existing: [member('l', { place: 'library', inScope: false })], staged: [member('a'), member('b')] });
  const members = compareMembers(compared);
  assertEquals(members.map((each) => each.id), ['l', 'a', 'b']);
  const start = { focus: 0, keep: 'l' };
  assertEquals(compareKey('ArrowLeft', start, members), { state: { focus: 2, keep: 'l' } });
  assertEquals(compareKey('k', start, members), null, 'the library file is kept anyway');
  assertEquals(compareKey('K', { focus: 1, keep: 'l' }, members), { state: { focus: 1, keep: 'a' } });
  assertEquals(compareKey('Enter', { focus: 1, keep: 'a' }, members), { apply: 'a' });
  assertEquals(compareKey('x', start, members), { separate: true });
  assertEquals(compareKey('q', start, members), null);
});

Deno.test('a staged file is said in its set: kept over the others, or what it copies or looks like', () => {
  assertEquals(fileSetLine(set('exact:k', { where: 'inbox', discard: ['d', 'e'] }), 'k'), 'Kept over 2 copies');
  assertEquals(fileSetLine(set('near:k', { kind: 'near', where: 'inbox', discard: ['d'] }), 'k'), 'Kept over 1 look-alike');
  assertEquals(fileSetLine(set('exact:k'), 'd'), 'A copy of a library photo');
  assertEquals(fileSetLine(set('exact:k', { where: 'inbox' }), 'd'), 'A copy of a photo in this import');
  assertEquals(fileSetLine(set('near:d', { kind: 'near' }), 'd'), 'Looks like a library photo');
  assertEquals(fileSetLine(set('near:d', { kind: 'near', where: 'inbox' }), 'd'), 'Looks like a photo in this import');
});

Deno.test('resolving a set drops its discards, or every other staged file when another is kept, only in the category', () => {
  const other = '/home/anna/staging/files/phone';
  const near = set('near:a', {
    kind: 'near',
    where: 'inbox',
    keep: 'a',
    discard: ['b'],
    staged: [member('a'), member('b', { copies: [{ id: 'b2', path: `${SCOPE}/b2.jpg` }] }), member('c'), member('o', { path: `${other}/o.jpg` })],
  });
  assertEquals(droppedPaths(near, 'a', SCOPE), [`${SCOPE}/b.jpg`, `${SCOPE}/b2.jpg`]);
  assertEquals(droppedPaths(near, 'c', SCOPE), [`${SCOPE}/a.jpg`, `${SCOPE}/b.jpg`, `${SCOPE}/b2.jpg`]);
});

Deno.test('keeping a set apart names its anchor first, then every other file; a set of one has nothing to keep apart', () => {
  const near = set('near:b', { kind: 'near', staged: [member('a'), member('b')], existing: [member('l', { path: '/albums/x/l.jpg', place: 'library' })] });
  assertEquals(separateCommand(near), `staging separate '${SCOPE}/b.jpg' '${SCOPE}/a.jpg' '/albums/x/l.jpg'`);
  assertEquals(separateCommand(set('near:a', { kind: 'near', staged: [member('a')] })), null);
});
