import { assertEquals } from '@std/assert';
import { CATEGORY_SLUG } from '@archive/staging/paths';
import { NO_UPLOADS } from '@ein/ui/lib';
import { categorySegments, categorySlug, categoryStages, freeSlug, heldFiles, KIND_LABELS, NEW_KINDS, preparingBaseline, preparingEta, stagesUnderWay } from '../overview.ts';

const counts = { files: 120, other: 7, indexing: 30, indexed: 90, undated: 10, bytes: 9_000, copies: { library: 0, inbox: 0 }, near: { library: 0, inbox: 0 } };

Deno.test('a category bar splits its media into prepared, ready and undated, and counts the other files apart', () => {
  assertEquals(categorySegments(counts), [
    { key: 'preparing', label: 'Being prepared', value: 30 },
    { key: 'ready', label: 'To sort', value: 80 },
    { key: 'undated', label: 'Needs a date', value: 10 },
    { key: 'other', label: 'Other files', value: 7 },
  ]);
  assertEquals(heldFiles(counts), 127);
});

Deno.test('an empty category has every segment at nothing', () => {
  const empty = categorySegments({ files: 0, other: 0, indexing: 0, indexed: 0, undated: 0, bytes: 0, copies: { library: 0, inbox: 0 }, near: { library: 0, inbox: 0 } });
  assertEquals(empty.map((segment) => segment.value), [0, 0, 0, 0]);
});

Deno.test('ready never goes below nothing when the counts disagree', () => {
  const ready = categorySegments({ files: 3, other: 0, indexing: 2, indexed: 1, undated: 2, bytes: 0, copies: { library: 0, inbox: 0 }, near: { library: 0, inbox: 0 } }).find(
    (segment) => segment.key === 'ready',
  );
  assertEquals(ready?.value, 0);
});

Deno.test('a new category is offered every kind but the inbox, each with a label', () => {
  assertEquals(NEW_KINDS.includes('inbox'), false);
  assertEquals(NEW_KINDS.length, Object.keys(KIND_LABELS).length - 1);
});

Deno.test('the time left is the files still being prepared at the rate they went since the baseline', () => {
  const start = { count: 1000, at: 0 };
  assertEquals(preparingEta(start, { count: 800, at: 60_000 }), 800 * 300);
  // Nothing has gone yet, or nothing is left: no estimate.
  assertEquals(preparingEta(start, { count: 1000, at: 60_000 }), undefined);
  assertEquals(preparingEta(start, { count: 0, at: 60_000 }), undefined);
  assertEquals(preparingEta(undefined, { count: 10, at: 0 }), undefined);
});

Deno.test('the baseline holds while the count falls, and starts again when files arrive', () => {
  const first = { count: 500, at: 0 };
  assertEquals(preparingBaseline(undefined, first), first);
  assertEquals(preparingBaseline(first, { count: 400, at: 30_000 }), first);
  const arrived = { count: 900, at: 60_000 };
  assertEquals(preparingBaseline(first, arrived), arrived);
});

Deno.test('a category name is made from its label', () => {
  assertEquals(categorySlug('Box 3'), 'box-3');
  assertEquals(categorySlug('  Google Photos — 2019!  '), 'google-photos-2019');
  assertEquals(categorySlug('Bilder på ön'), 'bilder-pa-on');
  assertEquals(categorySlug('Ældre øvelser & Straße'), 'aeldre-ovelser-strasse');
  assertEquals(categorySlug('***'), '');
  const long = categorySlug('a'.repeat(47) + ' b');
  assertEquals(long, 'a'.repeat(47));
  for (const label of ['Box 3', 'Scans från vinden', 'x'.repeat(80)]) assertEquals(CATEGORY_SLUG.test(categorySlug(label)), true, label);
});

Deno.test('a taken name gets the first free number, still a valid name', () => {
  assertEquals(freeSlug('scans', ['inbox']), 'scans');
  assertEquals(freeSlug('scans', ['scans', 'scans-2']), 'scans-3');
  const long = 'b'.repeat(48);
  const free = freeSlug(long, [long]);
  assertEquals(free, `${'b'.repeat(46)}-2`);
  assertEquals(CATEGORY_SLUG.test(free), true);
  assertEquals(freeSlug('', []), '');
});

Deno.test('files on their way in are arriving, then being prepared, then being grouped', () => {
  const organizer = { lastRunAt: '', lastFullAt: '', mode: 'full' as const, groups: 4, members: 70, pending: 30, byKind: {} };
  const uploads = { ...NO_UPLOADS, queued: 1_700, active: 4, done: 296 };
  assertEquals(categoryStages({ counts, organizer }, uploads), { arriving: { done: 296, of: 2_000 }, preparing: 30, grouping: 20 });
  // No organizer run yet: every read file waits for one. Finished uploads arrive no more.
  assertEquals(categoryStages({ counts, organizer: null }, { ...NO_UPLOADS, done: 2_000 }), { preparing: 30, grouping: 90 });
  // A group count above what is read (files filed since the run) is nothing waiting.
  const settled = categoryStages({ counts: { ...counts, indexing: 0, indexed: 60 }, organizer }, undefined);
  assertEquals(settled, { preparing: 0, grouping: 0 });
  assertEquals(stagesUnderWay(settled), false);
});
