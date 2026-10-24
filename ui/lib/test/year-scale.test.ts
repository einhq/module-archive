import { assertEquals } from '@std/assert';
import { positionAtOrAfter, positionAtOrBefore, scaleMarks, yearAt, yearScale } from '../year-scale.ts';

Deno.test('a scale steps through the years that hold something, empty years collapsed', () => {
  const scale = yearScale([2001, 1890, 2001, 2000, 1999], 2026);
  assertEquals(scale, [1890, 1999, 2000, 2001, 2026]);
  assertEquals(yearAt(scale, 1), 1999);
  assertEquals(yearAt(scale, 99), 2026);
  assertEquals(yearAt(scale, -3), 1890);
});

Deno.test('a year between steps puts a lower handle after it and an upper one before it', () => {
  const scale = [1890, 1999, 2000, 2001, 2026];
  assertEquals(positionAtOrAfter(scale, 1950), 1);
  assertEquals(positionAtOrBefore(scale, 1950), 0);
  assertEquals(positionAtOrAfter(scale, 2000), 2);
  assertEquals(positionAtOrBefore(scale, 2000), 2);
  assertEquals(positionAtOrAfter(scale, 3000), 4);
  assertEquals(positionAtOrBefore(scale, 1000), 0);
});

Deno.test('labels sit at the first year of each step, few and not crowded', () => {
  const scale = [1890, ...Array.from({ length: 30 }, (_, i) => 1990 + i)];
  const marks = scaleMarks(scale, 6);
  assertEquals(marks.map((mark) => mark.label), ['1890', '2000', '2010']);
  assertEquals(marks.length <= 6, true);
  for (let i = 1; i < marks.length; i++) assertEquals(marks[i].position - marks[i - 1].position >= (scale.length - 1) / 9, true);
  assertEquals(scaleMarks([], 6), []);
});
