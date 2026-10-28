/**
 * Reading a capture time in the browser.
 *
 * Mostly one property, stated several ways: whatever is rendered claims exactly as much as the
 * stored value does and not a minute more.
 */

import { assertEquals } from '@std/assert';
import { formatTaken, formatTakenParts, isVague, offsetOf, precisionOf, timeSourceLabel, viewerLocalTime, yearOf } from '../capture-time.ts';

Deno.test('precision comes from the value', () => {
  assertEquals(precisionOf('1975'), 'year');
  assertEquals(precisionOf('2004-03'), 'month');
  assertEquals(precisionOf('2003-04-30'), 'day');
  assertEquals(precisionOf('2003-04-30T14:03'), 'minute');
  assertEquals(precisionOf('2003-04-30T14:03:11+02:00'), 'second');
  assertEquals(precisionOf('nonsense'), undefined);
  assertEquals(precisionOf(undefined), undefined);

  assertEquals(yearOf('1975'), '1975');
  assertEquals(yearOf('2003-04-30T14:03:11+02:00'), '2003');
  assertEquals(yearOf('nonsense'), undefined);

  assertEquals(isVague('1975'), true);
  assertEquals(isVague('2004-03'), true);
  assertEquals(isVague('2003-04-30'), false);
});

Deno.test('nothing is rendered that the value does not claim', async (t) => {
  await t.step('a year is a year', () => {
    // Not "1 Jan 1975, 01:00", which is what handing this to Date.parse and toLocaleString
    // produces — a fabricated day, hour and minute rendered as confidently as a real one.
    assertEquals(formatTaken('1975', 'en-GB'), '1975');
  });

  await t.step('a month names its month', () => {
    assertEquals(formatTaken('2004-03', 'en-GB'), 'March 2004');
    assertEquals(formatTaken('2004-01', 'en-GB'), 'January 2004');
    assertEquals(formatTaken('2004-12', 'en-GB'), 'December 2004');
  });

  await t.step('a day stops at the day', () => {
    assertEquals(formatTaken('2003-04-30', 'en-GB'), '30 Apr 2003');
  });

  await t.step('below a day the clock appears, exactly as written', () => {
    assertEquals(formatTaken('2003-04-30T14:03', 'en-GB'), '30 Apr 2003, 14:03');
    assertEquals(formatTaken('2003-04-30T14:03:11', 'en-GB'), '30 Apr 2003, 14:03');
    assertEquals(formatTaken('2003-04-30T14:03:11', 'en-GB', { seconds: true }), '30 Apr 2003, 14:03:11');
    assertEquals(formatTaken('2003-04-30T14:03', 'en-GB', { seconds: true }), '30 Apr 2003, 14:03');
  });

  await t.step('the weekday is named once the value reaches a day', () => {
    assertEquals(formatTaken('2003-04-30', 'en-GB', { weekday: true }), 'Wednesday, 30 Apr 2003');
    assertEquals(formatTaken('2003-04-30T14:03:11', 'en-GB', { weekday: true, seconds: true }), 'Wednesday, 30 Apr 2003, 14:03:11');
    assertEquals(formatTaken('2004-03', 'en-GB', { weekday: true }), 'March 2004');
    assertEquals(formatTaken('1975', 'en-GB', { weekday: true }), '1975');
  });

  await t.step('the long form spells the month out, as the grid headers do', () => {
    assertEquals(formatTaken('2012-07-22', 'en-GB', { long: true }), '22 July 2012');
    assertEquals(formatTaken('2012-07-22T09:15', 'en-GB', { long: true, weekday: true }), 'Sunday, 22 July 2012, 09:15');
  });

  await t.step('the parts separate the calendar from the clock', () => {
    assertEquals(formatTakenParts('2012-07-22T09:15:30', 'en-GB', { seconds: true }), { date: '22 Jul 2012', clock: '09:15:30' });
    assertEquals(formatTakenParts('2012-07-22', 'en-GB'), { date: '22 Jul 2012' });
    assertEquals(formatTakenParts('2012-07-22', 'en-GB', { weekday: 'short' }), { date: 'Sun, 22 Jul 2012' });
    assertEquals(formatTakenParts('2012-07-22', 'en-GB', { weekday: true, long: true }), { date: 'Sunday, 22 July 2012' });
    assertEquals(formatTakenParts('2012', 'en-GB'), { date: '2012' });
    assertEquals(formatTakenParts('not a time', 'en-GB'), { date: 'not a time' });
  });

  await t.step("a value with an offset reads in that offset, not the viewer's", () => {
    // A photograph taken at noon in Tokyo is a noon photograph. Converting it to the reader's
    // zone would make it a 4am one.
    assertEquals(formatTaken('2015-07-25T12:00:00+09:00', 'en-GB'), '25 Jul 2015, 12:00');
    assertEquals(formatTaken('2015-07-25T12:00:00Z', 'en-GB'), '25 Jul 2015, 12:00');
  });

  await t.step('something unreadable comes back as it went in', () => {
    // A blank where a date should be hides the bug; the raw value shows it.
    assertEquals(formatTaken('not-a-date'), 'not-a-date');
    assertEquals(formatTaken(undefined), '');
  });
});

Deno.test('offsets', () => {
  assertEquals(offsetOf('2003-04-30T14:03:11+02:00'), 7200);
  assertEquals(offsetOf('2003-04-30T14:03:11-05:30'), -19800);
  assertEquals(offsetOf('2003-04-30T14:03:11Z'), 0);
  assertEquals(offsetOf('2003-04-30T14:03:11'), undefined);
  assertEquals(offsetOf('1975'), undefined);
});

Deno.test("the viewer's own time is offered only when it says something", async (t) => {
  await t.step('nothing to compare against', () => {
    // No instant, or a wall clock that names no zone — the common case, where it would be a
    // noise line on every lightbox.
    assertEquals(viewerLocalTime('2015-07-25T14:03:11', undefined), undefined);
    assertEquals(viewerLocalTime('2015-07-25T14:03:11', '2015-07-25T12:03:11Z'), undefined);
    assertEquals(viewerLocalTime(undefined, '2015-07-25T12:03:11Z'), undefined);
  });

  await t.step('a photograph from another zone gets a second reading', () => {
    // Tokyo noon: whatever zone the test host is in, it is not +09:00 in July unless it is
    // Japan, so this either produces a string or correctly declines to.
    const shown = viewerLocalTime('2015-07-25T12:00:00+09:00', '2015-07-25T03:00:00Z', 'en-GB');
    const hostOffset = -new Date('2015-07-25T03:00:00Z').getTimezoneOffset() * 60;
    if (hostOffset === 9 * 3600) assertEquals(shown, undefined);
    else assertEquals(typeof shown, 'string');
  });
});

Deno.test("a time's source is named in words, and a scan says its scanner's clocks were set aside", () => {
  assertEquals(timeSourceLabel('name'), 'from the file name');
  assertEquals(timeSourceLabel('device'), 'from the camera clock');
  assertEquals(timeSourceLabel('sidecar'), 'from Google Photos or a sidecar');
  assertEquals(timeSourceLabel('manual', true), 'entered by hand · a scan: its scanner’s clocks are not when it was taken');
  assertEquals(timeSourceLabel(undefined, true), 'a scan: its scanner’s clocks are not when it was taken');
  assertEquals(timeSourceLabel(undefined), undefined);
});
