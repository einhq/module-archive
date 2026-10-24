import { assertEquals } from '@std/assert';
import type { StagingAcceptResult } from '@archive/staging/api';
import { acceptSummary, journalOf, leftOf, progressLine } from '../bulk.ts';

Deno.test('the journal entries of each kind of answer are kept for Undo all', () => {
  assertEquals(journalOf({ ok: true, journal: '01JA', moved: 3 }), ['01JA']);
  assertEquals(journalOf({ ok: true, journal: null }), []);
  assertEquals(journalOf({ ok: true, journal: ['01JA', '01JB'], plan: [], skipped: [] }), ['01JA', '01JB']);
  assertEquals(journalOf({ album: '/archive/albums/Summer 2019', added: [], moved: [], already: [] }), []);
  assertEquals(journalOf({ ok: true, groups: ['/g'], later: true }), []);
});

Deno.test('groups an answer left as they were come back, whatever the verb', () => {
  assertEquals(leftOf({ changed: ['/g/1'], failed: [] }), ['/g/1']);
  assertEquals(leftOf({ skipped: [{ group: '/g/2', reason: 'below-confidence' }, { group: '/g/1', reason: 'changed' }], changed: ['/g/1'] }), ['/g/1', '/g/2']);
  assertEquals(leftOf({ ok: true, groups: ['/g/3'], later: true }), []);
});

Deno.test('a run says how far it has come in photos and groups', () => {
  assertEquals(progressLine('Filing', { groups: 37, files: 1840 }, { groups: 214, files: 9830 }), 'Filing 1,840 of 9,830 photos · 37 of 214 groups');
  assertEquals(progressLine('Putting aside', { groups: 100, files: 0 }, { groups: 200, files: 0 }), 'Putting aside 100 of 200 groups');
});

const album = (title: string) => ({ id: title, path: `/archive/albums/${title}`, title, ownership: 'shared', writable: true }) as never;

Deno.test('the plan is summed by destination, at the confidence asked for', () => {
  const plan: StagingAcceptResult['plan'] = [
    { group: '/g/1', proposal: { action: 'existing', album: album('Lake trip 2019'), confidence: 'high', reason: 'match' }, files: 40 },
    { group: '/g/2', proposal: { action: 'existing', album: album('Lake trip 2019'), confidence: 'medium', reason: 'category' }, files: 10 },
    { group: '/g/3', proposal: { action: 'existing', album: album('Box 3'), confidence: 'medium', reason: 'category' }, files: 5 },
    { group: '/g/4', proposal: { action: 'new', title: 'Midsummer eve', confidence: 'low', compared: false }, files: 12 },
    { group: '/g/5', proposal: { action: 'none' }, files: 3 },
  ];
  const every = acceptSummary(plan, ['/g/6'], 'low');
  assertEquals(every.existing.map((each) => [each.title, each.groups, each.files]), [['Lake trip 2019', 2, 50], ['Box 3', 1, 5]]);
  assertEquals(every.newAlbums, { groups: 1, files: 12 });
  assertEquals(every.skipped, { changed: 1, unsure: 0, none: 1 });
  assertEquals(every.filed, ['/g/1', '/g/2', '/g/3', '/g/4']);

  const sure = acceptSummary(plan, [], 'high');
  assertEquals(sure.filed, ['/g/1']);
  assertEquals(sure.skipped, { changed: 0, unsure: 3, none: 1 });
});

Deno.test("a lane's matched days are summed apart, and clutter proposed for the trash is never accepted", () => {
  const plan: StagingAcceptResult['plan'] = [
    { group: '/g/lane', proposal: { action: 'parts', parts: 6, files: 140, confidence: 'medium' }, files: 140 },
    { group: '/g/clutter', proposal: { action: 'discard', confidence: 'medium' }, files: 300 },
  ];
  const summary = acceptSummary(plan, [], 'medium');
  assertEquals(summary.matchedDays, { groups: 1, files: 140 });
  assertEquals(summary.filed, ['/g/lane']);
  assertEquals(summary.skipped, { changed: 0, unsure: 0, none: 1 });
});
