import { assertEquals } from '@std/assert';
import { firstFreeDay } from '../free-event-day.ts';

Deno.test('firstFreeDay', async (t) => {
  await t.step('the earliest day without an event, whatever order the days come in', () => {
    assertEquals(firstFreeDay(['2005-06-17', '2005-06-15', '2005-06-16'], ['2005-06-15']), '2005-06-16');
  });

  await t.step('an event dated with a time takes its whole day', () => {
    assertEquals(firstFreeDay(['2005-06-15', '2005-06-16'], ['2005-06-15T18:30:00']), '2005-06-16');
  });

  await t.step('the first day when every day has an event', () => {
    assertEquals(firstFreeDay(['2005-06-16', '2005-06-15'], ['2005-06-15', '2005-06-16']), '2005-06-15');
  });

  await t.step('nothing when there are no days', () => {
    assertEquals(firstFreeDay([], ['2005-06-15']), undefined);
  });
});
