import { assertEquals } from '@std/assert';
import { daysBetween, seekDay, stepCandidate, stripDays } from '../compare.ts';

Deno.test("the strip is read from the day before the group's first", () => {
  assertEquals(seekDay('2019-06-14T08:00:00Z'), '2019-06-13');
  assertEquals(seekDay('2019-03-01T10:00:00'), '2019-02-28');
  assertEquals(seekDay('2019'), undefined);
  assertEquals(seekDay(undefined), undefined);
});

Deno.test("the group's days, from its first to its last", () => {
  assertEquals([...daysBetween('2019-06-14T08:00:00', '2019-06-16T20:00:00')], ['2019-06-14', '2019-06-15', '2019-06-16']);
  assertEquals([...daysBetween('2019-06-14T08:00:00', undefined)], ['2019-06-14']);
  assertEquals(daysBetween(undefined, undefined).size, 0);
});

Deno.test("the album's pictures as days, the group's days marked, the undated last", () => {
  const items = [
    { at: '2019-06-13T10:00:00' },
    { at: '2019-06-14T09:00:00' },
    { at: '2019-06-14T11:00:00' },
    { at: undefined },
    { at: '2019-06-20T08:00:00' },
  ];
  const days = stripDays(items, (item) => item.at, new Set(['2019-06-14']));
  assertEquals(days.map((day) => [day.day, day.label, day.items.length, day.ours]), [
    ['2019-06-13', '13 Jun', 1, false],
    ['2019-06-14', '14 Jun', 2, true],
    ['2019-06-20', '20 Jun', 1, false],
    ['', 'No date', 1, false],
  ]);
});

Deno.test('the highlight steps among the candidates and holds at either end', () => {
  assertEquals([stepCandidate(0, 1, 3), stepCandidate(2, 1, 3), stepCandidate(0, -1, 3), stepCandidate(1, -1, 3)], [1, 2, 0, 0]);
  assertEquals(stepCandidate(0, 1, 0), 0);
});
