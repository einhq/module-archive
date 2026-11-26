import { assertEquals } from '@std/assert';
import { dayAfter, seekDay } from '../album-days.ts';

Deno.test("an oldest-first read starts the day before the group's first", () => {
  assertEquals(seekDay('2019-06-14T08:00:00Z'), '2019-06-13');
  assertEquals(seekDay('2019-03-01T10:00:00'), '2019-02-28');
  assertEquals(seekDay(undefined), undefined);
  assertEquals(seekDay('sometime'), undefined);
});

Deno.test('a newest-first read starts the day after the group, across a month and a year', () => {
  assertEquals(dayAfter('2019-06-14T08:00:00Z'), '2019-06-15');
  assertEquals(dayAfter('2019-02-28T10:00:00'), '2019-03-01');
  assertEquals(dayAfter('2019-12-31'), '2020-01-01');
  assertEquals(dayAfter(undefined), undefined);
  assertEquals(dayAfter('sometime'), undefined);
});
