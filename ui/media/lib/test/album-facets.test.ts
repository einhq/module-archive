import { assertEquals } from '@std/assert';
import { compareByDate, dateKeyOf, facetsFromItems, indexAtDate, sectionsForItems } from '../album-facets.ts';

Deno.test('a date comes from timeStart, and falls back to modtime', () => {
  assertEquals(dateKeyOf({ timeStart: '2021-07-04T09:00:00Z' }), '2021-07-04');
  assertEquals(dateKeyOf({ modtime: Date.UTC(2019, 2, 9) }), '2019-03-09');
  // timeStart wins when both are there.
  assertEquals(dateKeyOf({ timeStart: '2021-07-04T09:00:00Z', modtime: Date.UTC(2019, 2, 9) }), '2021-07-04');
  // Unparseable falls through to modtime rather than producing a bad key.
  assertEquals(dateKeyOf({ timeStart: 'not a date', modtime: Date.UTC(2019, 2, 9) }), '2019-03-09');
  assertEquals(dateKeyOf({}), undefined);
});

Deno.test('a date is the one written, at the precision it was written with', () => {
  // The wall clock's day, whatever zone the browser is in and whatever offset it carries.
  assertEquals(dateKeyOf({ timeStart: '2021-07-04T00:30:00' }), '2021-07-04');
  assertEquals(dateKeyOf({ timeStart: '2021-07-04T00:30:00+02:00' }), '2021-07-04');
  assertEquals(dateKeyOf({ timeStart: '2021-07-04T23:30:00-05:00' }), '2021-07-04');
  assertEquals(dateKeyOf({ timeStart: '2021-07-04T09:00' }), '2021-07-04');
  assertEquals(dateKeyOf({ timeStart: '2021-07-04' }), '2021-07-04');
  // A partial date gains no day or month.
  assertEquals(dateKeyOf({ timeStart: '1975-06' }), '1975-06');
  assertEquals(dateKeyOf({ timeStart: '1975' }), '1975');
  assertEquals(dateKeyOf({ timeStart: '19750', modtime: Date.UTC(2019, 2, 9) }), '2019-03-09');
});

Deno.test('facets count years, months and days, ascending', () => {
  const facets = facetsFromItems([
    { timeStart: '2021-07-04T09:00:00Z' },
    { timeStart: '2021-07-04T18:00:00Z' },
    { timeStart: '2021-08-01T00:00:00Z' },
    { timeStart: '2019-03-09T00:00:00Z' },
  ]);

  assertEquals(facets.years, [{ year: 2019, count: 1 }, { year: 2021, count: 3 }]);
  assertEquals(facets.months, [{ key: '2019-03', count: 1 }, { key: '2021-07', count: 2 }, { key: '2021-08', count: 1 }]);
  assertEquals(facets.days, [{ key: '2019-03-09', count: 1 }, { key: '2021-07-04', count: 2 }, { key: '2021-08-01', count: 1 }]);
});

Deno.test('a partial date counts in its year and month, not in a day', () => {
  const facets = facetsFromItems([{ timeStart: '1975' }, { timeStart: '1975-06' }, { timeStart: '1975-06-14T12:00:00' }]);

  assertEquals(facets.years, [{ year: 1975, count: 3 }]);
  // A year-only date is under a month key that is just the year.
  assertEquals(facets.months, [{ key: '1975', count: 1 }, { key: '1975-06', count: 2 }]);
  assertEquals(facets.days, [{ key: '1975-06-14', count: 1 }]);
});

Deno.test('date order follows the written date, partial dates first', () => {
  const items = [
    { timeStart: '1975-06-14T12:00:00' },
    { timeStart: '1975-06' },
    {},
    { timeStart: '1975-06-14T08:00:00' },
    { timeStart: '1975' },
    // Later in UTC than 1975-06-14T23:00 local wherever the browser is east of UTC, but the 13th as written.
    { timeStart: '1975-06-13T23:30:00-05:00' },
  ];

  assertEquals(items.toSorted(compareByDate).map((item) => item.timeStart), [
    undefined,
    '1975',
    '1975-06',
    '1975-06-13T23:30:00-05:00',
    '1975-06-14T08:00:00',
    '1975-06-14T12:00:00',
  ]);
});

Deno.test('a seek lands on the first item inside or past the date, either way round', () => {
  const ascending = [{ timeStart: '1975' }, { timeStart: '1975-06-14' }, { timeStart: '1980-01-02' }, { timeStart: '1990-05-01' }];
  const descending = ascending.toReversed();

  assertEquals(indexAtDate(ascending, '1980', true), 2);
  assertEquals(indexAtDate(ascending, '1975-06', true), 1);
  assertEquals(indexAtDate(ascending, '1985-03-01', true), 3);
  assertEquals(indexAtDate(ascending, '1995', true), -1);

  assertEquals(indexAtDate(descending, '1980', false), 1);
  assertEquals(indexAtDate(descending, '1985-03-01', false), 1);
  assertEquals(indexAtDate(descending, '1975-06', false), 2);
  assertEquals(indexAtDate(descending, '1970', false), -1);
});

Deno.test('an undated album occupies no time and is left out', () => {
  const facets = facetsFromItems([{}, { timeStart: '2021-07-04T09:00:00Z' }, {}]);
  assertEquals(facets.years, [{ year: 2021, count: 1 }]);
  assertEquals(facets.days.length, 1);
});

Deno.test('facets of nothing are empty rather than undefined', () => {
  assertEquals(facetsFromItems([]), { years: [], months: [], days: [] });
});

Deno.test('sections start at whole rows and run to the next bucket', () => {
  const geometry = { columns: 2, cardHeight: 100, gap: 10, height: 330 };
  // Rows of two: indexes 0,1 | 2,3 | 4,5
  const items = [
    { timeStart: '2021-07-01T00:00:00Z' },
    { timeStart: '2021-07-02T00:00:00Z' },
    // A new month starting mid-row snaps back to that row's top.
    { timeStart: '2021-08-01T00:00:00Z' },
    { timeStart: '2021-08-02T00:00:00Z' },
    { timeStart: '2021-09-01T00:00:00Z' },
  ];

  assertEquals(sectionsForItems(items, 7, geometry), [
    { key: '2021-07', offset: 0, size: 110 },
    { key: '2021-08', offset: 110, size: 110 },
    { key: '2021-09', offset: 220, size: 110 },
  ]);
});

Deno.test('the last section runs to the bottom of the grid', () => {
  const geometry = { columns: 1, cardHeight: 100, gap: 0, height: 200 };
  const sections = sectionsForItems(
    [{ timeStart: '2021-07-01T00:00:00Z' }, { timeStart: '2021-08-01T00:00:00Z' }],
    7,
    geometry,
  );
  assertEquals(sections.at(-1), { key: '2021-08', offset: 100, size: 100 });
});

Deno.test('sections of nothing are empty', () => {
  assertEquals(sectionsForItems([], 7, { columns: 4, cardHeight: 100, gap: 10, height: 0 }), []);
});
