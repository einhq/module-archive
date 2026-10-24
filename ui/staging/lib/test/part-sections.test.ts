import { assertEquals } from '@std/assert';
import { PART_DAYS_MAX, partSections, stepPart } from '../part-sections.ts';

type Item = { path: string; takenAt?: string };
const at = (item: Item) => item.takenAt;

Deno.test('a section per day, a vaguer date its own, and the pictures without a date last', () => {
  const items: Item[] = [
    { path: 'a', takenAt: '1975' },
    { path: 'b', takenAt: '2019-06-14T08:00:00' },
    { path: 'c' },
    { path: 'd', takenAt: '2019-06-14T09:30:00' },
    { path: 'e', takenAt: '2019-06-15T10:00:00' },
  ];
  const layout = partSections(items, at);
  assertEquals(layout.byMonth, false);
  assertEquals(layout.items.map((item) => item.path), ['a', 'b', 'd', 'e', 'c']);
  assertEquals(
    layout.sections.map((section) => [section.key, section.label, section.items.map((item) => item.path), section.startIndex]),
    [
      ['1975', '1975', ['a'], 0],
      ['2019-06-14', '14 June 2019', ['b', 'd'], 1],
      ['2019-06-15', '15 June 2019', ['e'], 3],
      ['', 'No date', ['c'], 4],
    ],
  );
  assertEquals(new Set(layout.sections.map((section) => section.id)).size, 4);
});

Deno.test(`more than ${PART_DAYS_MAX} days are months, with their days as chips`, () => {
  // An Everyday lane: two pictures a day from 1 May, 45 days, and one without a date.
  const items: Item[] = [{ path: 'undated' }];
  for (let day = 0; day < 45; day++) {
    const date = new Date(Date.UTC(2014, 4, 1 + day)).toISOString().slice(0, 10);
    items.push({ path: `${date}-1`, takenAt: `${date}T09:00:00` }, { path: `${date}-2`, takenAt: `${date}T17:00:00` });
  }
  const layout = partSections(items, at);
  assertEquals(layout.byMonth, true);
  assertEquals(layout.sections.map((section) => [section.label, section.items.length, section.startIndex, section.days?.length]), [
    ['May 2014', 62, 0, 31],
    ['June 2014', 28, 62, 14],
    ['No date', 1, 90, undefined],
  ]);
  const june = layout.sections[1].days!;
  assertEquals(june[0], { key: '2014-06-01', label: '1 Jun', count: 2, startIndex: 62 });
  assertEquals(june.at(-1), { key: '2014-06-14', label: '14 Jun', count: 2, startIndex: 88 });
  assertEquals(layout.items.at(-1)?.path, 'undated');

  // Exactly the limit is still a section per day.
  assertEquals(partSections(items.slice(0, 1 + 2 * PART_DAYS_MAX), at).byMonth, false);
});

Deno.test('[ and ] step through the parts, and stop at either end', () => {
  const sections = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assertEquals(stepPart(sections, null, 1), 'a');
  assertEquals(stepPart(sections, null, -1), 'c');
  assertEquals(stepPart(sections, 'b', 1), 'c');
  assertEquals(stepPart(sections, 'c', 1), 'c');
  assertEquals(stepPart(sections, 'a', -1), 'a');
  assertEquals(stepPart(sections, 'gone', 1), 'a');
  assertEquals(stepPart([], null, 1), null);
});
