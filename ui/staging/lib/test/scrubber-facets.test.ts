import { assertEquals } from '@std/assert';
import { railFacets, seekIndex } from '../scrubber-facets.ts';

const rows = [
  { timeStart: '2018-12-24T17:00:00Z' },
  { timeStart: '2019-06-14T08:00:00Z' },
  { timeStart: '2019-06-14T15:00:00Z' },
  { timeStart: '2019-06-20T09:00:00' },
  {},
];

Deno.test('the rail counts groups by the year, month and day they start, and not the undated', () => {
  assertEquals(railFacets(rows), {
    years: [{ year: 2018, count: 1 }, { year: 2019, count: 3 }],
    months: [{ key: '2018-12', count: 1 }, { key: '2019-06', count: 3 }],
    days: [{ key: '2018-12-24', count: 1 }, { key: '2019-06-14', count: 2 }, { key: '2019-06-20', count: 1 }],
  });
});

Deno.test('a date on the rail lands on the first group from it, in either order', () => {
  assertEquals(seekIndex(rows, '2019-06', true), 1);
  assertEquals(seekIndex(rows, '2019-06-15', true), 3);
  assertEquals(seekIndex(rows, '2020', true), 3);
  const newest = [rows[3], rows[2], rows[1], rows[0], rows[4]];
  assertEquals(seekIndex(newest, '2019-06-14', false), 1);
  assertEquals(seekIndex(newest, '2019', false), 0);
  assertEquals(seekIndex(newest, '2018-12', false), 3);
  assertEquals(seekIndex([{}], '2019', true), -1);
});

Deno.test("a long group's pictures: a vaguer date counts as far as it is known", () => {
  const pictures = [
    { timeStart: '1975' },
    { timeStart: '1975-06' },
    { timeStart: '1975-06-21T14:03' },
    { timeStart: '1975-06-21T15:10' },
    { timeStart: '1976-01-02' },
    { timeStart: undefined },
    { timeStart: 'not a date' },
  ];
  assertEquals(railFacets(pictures), {
    years: [{ year: 1975, count: 4 }, { year: 1976, count: 1 }],
    months: [{ key: '1975-06', count: 3 }, { key: '1976-01', count: 1 }],
    days: [{ key: '1975-06-21', count: 2 }, { key: '1976-01-02', count: 1 }],
  });
  // A seek lands on the first picture of the month, past the one known only to the year.
  assertEquals(seekIndex(pictures, '1975-06', true), 1);
  assertEquals(seekIndex(pictures, '1975-06-21', true), 2);
  assertEquals(seekIndex(pictures, '1976', true), 4);
});
