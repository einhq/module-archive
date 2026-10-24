/**
 * Pure-unit tests for ageAt: completed years from a possibly partial birth date.
 */

import { assertEquals } from '@std/assert';
import { ageAt, ageMonthsAt } from '../../lib/people/genealogy.ts';

Deno.test('ageAt counts completed years', () => {
  assertEquals(ageAt('1980-05-02', '2019-06-14T13:45:02Z'), { years: 39, approx: false });
  assertEquals(ageAt('1980-05-02T08:15', '2019-06-14T13:45:02Z'), { years: 39, approx: false });
  // birthday not yet reached that year
  assertEquals(ageAt('1980-05-02', '2019-05-01T00:00:00Z'), { years: 38, approx: false });
  // exactly on the birthday
  assertEquals(ageAt('1980-05-02', '2019-05-02T00:00:00Z'), { years: 39, approx: false });
});

Deno.test('ageAt marks partial birth dates approximate', () => {
  assertEquals(ageAt('1980', '2019-06-14T00:00:00Z'), { years: 39, approx: true });
  assertEquals(ageAt('1980-05', '2019-06-14T00:00:00Z'), { years: 39, approx: true });
});

Deno.test('ageAt rejects bad input and moments before birth', () => {
  assertEquals(ageAt('', '2019-06-14'), null);
  assertEquals(ageAt('14 june 1980', '2019-06-14'), null);
  assertEquals(ageAt('1980-05-02', 'not a date'), null);
  assertEquals(ageAt('1980-05-02', '1979-01-01'), null);
});

Deno.test('ageAt accepts Date and epoch millis', () => {
  assertEquals(ageAt('1980-05-02', new Date('2019-06-14T00:00:00Z')), { years: 39, approx: false });
  assertEquals(ageAt('1980-05-02', Date.parse('2019-06-14T00:00:00Z')), { years: 39, approx: false });
});

Deno.test('ageMonthsAt counts completed infant months', () => {
  assertEquals(ageMonthsAt('2019-01-20', '2019-06-14T00:00:00Z'), { months: 4, approx: false });
  assertEquals(ageMonthsAt('2019-01-14', '2019-06-14T00:00:00Z'), { months: 5, approx: false });
  assertEquals(ageMonthsAt('2019-01', '2019-06-14T00:00:00Z'), { months: 5, approx: true });
  assertEquals(ageMonthsAt('2020-01-01', '2019-06-14T00:00:00Z'), null);
});
