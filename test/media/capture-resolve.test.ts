/**
 * Choosing a capture time from the sources that claim to know it.
 *
 * The clock cases are shapes found in the legacy data, not invented scenarios — the ranking, the
 * sanity window and the hour rounding each exist because of one, and the tests say which. The
 * sidecar cases are a Google Photos Takeout's and an editor's XMP, with invented times.
 */

import { assertEquals } from '@std/assert';
import type { CaptureDateParts } from '@archive/media/capture-resolve';
import { isValidGpsDate, recoverOffsetSeconds, resolveTime, stampedSources, timeAttrs, whenFromExifAttrs } from '@archive/media/capture-resolve';

const STOCKHOLM = 'Europe/Stockholm';

/** `2015-07-25T14:03:11` as exif parts. */
const parts = (iso: string, timezone?: string): CaptureDateParts => {
  const [date, time = '00:00:00'] = iso.split('T');
  const [year, month, day] = date.split('-');
  const [hour, minute, second] = time.split(':');
  return { year, month, day, hour, minute, second, ...(timezone ? { timezone } : {}) };
};

Deno.test('the ranking is manual, then gps, then device', async (t) => {
  const device = parts('2015-07-25T14:03:11');
  const gps = parts('2015-07-25T12:03:11');

  await t.step('a person who looked at the photograph wins', () => {
    const resolved = resolveTime({ manual: '1975', gps, device, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAtSource, 'manual');
    assertEquals(resolved.takenAt, '1975');
  });

  await t.step('gps beats the camera clock, which is the old system order restored', () => {
    const resolved = resolveTime({ gps, device, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAtSource, 'gps');
    assertEquals(resolved.takenAtUtc, '2015-07-25T12:03:11Z');
  });

  await t.step('the camera clock is what 95,449 of the legacy files have and nothing else', () => {
    const resolved = resolveTime({ device, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAtSource, 'device');
  });

  await t.step('nothing usable resolves to nothing, and clears rather than keeps', () => {
    assertEquals(resolveTime({ archiveZone: STOCKHOLM }), null);
    assertEquals(timeAttrs(null), { takenAt: null, takenAtUtc: null, takenAtSource: null });
  });

  await t.step('a manual value that is not a capture time falls through to the sources', () => {
    const resolved = resolveTime({ manual: '12/25/2003', device, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAtSource, 'device');
  });
});

Deno.test('a gps fix carries the instant, the camera carries the wall clock', async (t) => {
  await t.step('the pair recovers the offset the photographer was standing in', () => {
    // +1h and +2h — Swedish winter and summer.
    const resolved = resolveTime({
      gps: parts('2015-07-25T12:03:11'),
      device: parts('2015-07-25T14:03:11'),
      archiveZone: STOCKHOLM,
    })!;
    assertEquals(resolved.takenAt, '2015-07-25T14:03:11+02:00');
    assertEquals(resolved.takenAtUtc, '2015-07-25T12:03:11Z');
  });

  await t.step('a camera running fast is drift, not a timezone nobody keeps', () => {
    // A camera running a quarter of an hour fast. Rounding to the hour keeps the offset honest
    // and leaves the quarter hour where it belongs: in the wall clock the camera wrote.
    assertEquals(recoverOffsetSeconds(parts('2015-01-25T14:18:11'), parts('2015-01-25T13:03:11')), 3600);
    const resolved = resolveTime({
      gps: parts('2015-01-25T13:03:11'),
      device: parts('2015-01-25T14:18:11'),
      archiveZone: STOCKHOLM,
    })!;
    assertEquals(resolved.takenAt, '2015-01-25T14:18:11+01:00');
    // The instant stays the receiver's, so the drift never reaches the ordering.
    assertEquals(resolved.takenAtUtc, '2015-01-25T13:03:11Z');
  });

  await t.step('travel: +8h on 74 files and +11h on 16', () => {
    assertEquals(recoverOffsetSeconds(parts('2015-07-25T20:03:11'), parts('2015-07-25T12:03:11')), 8 * 3600);
    assertEquals(recoverOffsetSeconds(parts('2015-07-25T23:03:11'), parts('2015-07-25T12:03:11')), 11 * 3600);
  });

  await t.step('the 25 files with a fix and no camera date show the UTC reading itself', () => {
    const resolved = resolveTime({ gps: parts('2015-07-25T12:03:11'), archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAt, '2015-07-25T12:03:11Z');
    assertEquals(resolved.takenAtUtc, '2015-07-25T12:03:11Z');
  });
});

Deno.test('a stale gps fix is disbelieved', async (t) => {
  await t.step('the corpus case: five files shot on the 21st carrying the 19th', () => {
    // The receiver never got a lock and reported the one it had, two days old.
    const device = parts('2014-11-21T22:53:37');
    const gps = parts('2014-11-19T11:41:01');
    assertEquals(isValidGpsDate(gps, device).ok, false);

    const resolved = resolveTime({ gps, device, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAtSource, 'device');
    assertEquals(resolved.takenAt.startsWith('2014-11-21T22:53:37'), true);
  });

  await t.step('a real timezone is inside the window and stays believed', () => {
    // +14:00 is the widest offset anybody keeps; the window is 26h to leave room for a camera
    // clock that has never been set.
    assertEquals(isValidGpsDate(parts('2015-07-25T00:03:11'), parts('2015-07-25T14:03:11')).ok, true);
    assertEquals(isValidGpsDate(parts('2015-07-24T22:03:11'), parts('2015-07-25T14:03:11')).ok, true);
  });

  await t.step('with no camera date there is nothing to check against', () => {
    assertEquals(isValidGpsDate(parts('1999-01-01T00:00:00')).ok, true);
  });

  await t.step('the reason is reported, not swallowed', () => {
    const verdict = isValidGpsDate(parts('2014-11-19T11:41:01'), parts('2014-11-21T22:53:37'));
    assertEquals(verdict.ok, false);
    assertEquals(verdict.ok === false && verdict.reason.includes('stale fix'), true);
  });
});

Deno.test('a camera clock needs an offset from somewhere', async (t) => {
  await t.step('an offset the camera itself wrote outranks the registry', () => {
    const resolved = resolveTime({
      device: parts('2015-07-25T14:03:11', '+01:00'),
      deviceOffsetAt: () => 7200,
      archiveZone: STOCKHOLM,
    })!;
    assertEquals(resolved.takenAt, '2015-07-25T14:03:11+01:00');
    assertEquals(resolved.takenAtUtc, '2015-07-25T13:03:11Z');
  });

  await t.step('otherwise the device registry decides', () => {
    const resolved = resolveTime({
      device: parts('2015-07-25T14:03:11'),
      deviceOffsetAt: () => 3600,
      archiveZone: STOCKHOLM,
    })!;
    assertEquals(resolved.takenAt, '2015-07-25T14:03:11+01:00');
    assertEquals(resolved.takenAtUtc, '2015-07-25T13:03:11Z');
  });

  await t.step('and with neither, the wall clock stays unstamped and the archive zone dates it', () => {
    const resolved = resolveTime({ device: parts('2015-07-25T14:03:11'), archiveZone: STOCKHOLM })!;
    // No offset is claimed, because none is known — the attr says exactly what it knows.
    assertEquals(resolved.takenAt, '2015-07-25T14:03:11');
    assertEquals(resolved.takenAtUtc, '2015-07-25T12:03:11Z');
  });
});

Deno.test('a UTC reading is placed on the wall clock where the device stood', async (t) => {
  await t.step("in the device registry's zone", () => {
    const resolved = resolveTime({
      device: parts('2023-06-02T17:48:23', 'Z'),
      deviceOffsetAt: (wallClock) => Temporal.PlainDateTime.from(wallClock).toZonedDateTime('Europe/London').offsetNanoseconds / 1e9,
      archiveZone: STOCKHOLM,
    })!;
    assertEquals(resolved.takenAt, '2023-06-02T18:48:23+01:00');
    assertEquals(resolved.takenAtUtc, '2023-06-02T17:48:23Z');
    assertEquals(resolved.takenAtSource, 'device');
  });

  await t.step('in the archive zone when the registry knows nothing', () => {
    const resolved = resolveTime({ device: parts('2025-01-04T02:22:04', 'Z'), archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAt, '2025-01-04T03:22:04+01:00');
    assertEquals(resolved.takenAtUtc, '2025-01-04T02:22:04Z');
  });

  await t.step('across midnight and a summer-time change, by the offset at the instant', () => {
    // 00:30Z on the last Sunday of March is 01:30 CET, half an hour before clocks go forward.
    const resolved = resolveTime({ device: parts('2024-03-31T00:30:00', 'Z'), archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAt, '2024-03-31T01:30:00+01:00');
    assertEquals(resolved.takenAtUtc, '2024-03-31T00:30:00Z');
  });

  await t.step('and a gps fix agreeing with it stamps the same offset', () => {
    const resolved = resolveTime({
      device: parts('2023-06-02T17:48:23', 'Z'),
      gps: parts('2023-06-02T17:48:20', '+00:00'),
      archiveZone: STOCKHOLM,
    })!;
    assertEquals(resolved.takenAtSource, 'gps');
    assertEquals(resolved.takenAt, '2023-06-02T19:48:23+02:00');
  });
});

Deno.test('a device that keeps video times in UTC decides an unmarked container reading', async (t) => {
  const reading = { ...parts('2023-06-02T17:48:23'), quicktime: true as const };

  await t.step('with the setting it is UTC', () => {
    const resolved = resolveTime({ device: reading, quicktimeUtc: true, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAt, '2023-06-02T19:48:23+02:00');
    assertEquals(resolved.takenAtUtc, '2023-06-02T17:48:23Z');
  });

  await t.step('without it, a wall clock', () => {
    const resolved = resolveTime({ device: reading, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAt, '2023-06-02T17:48:23');
    assertEquals(resolved.takenAtUtc, '2023-06-02T15:48:23Z');
  });

  await t.step("a still image's reading is not touched by it", () => {
    const resolved = resolveTime({ device: parts('2023-06-02T17:48:23'), quicktimeUtc: true, archiveZone: STOCKHOLM })!;
    assertEquals(resolved.takenAt, '2023-06-02T17:48:23');
  });
});

Deno.test('a manual time keeps every precision the old system allowed', async (t) => {
  const cases: [string, string][] = [
    // A manual time may be a bare year, a month, a day or a time of day.
    ['1975', '1974-12-31T23:00:00Z'],
    ['2004-03', '2004-02-29T23:00:00Z'],
    ['2003-04-30', '2003-04-29T22:00:00Z'],
    ['2003-04-30T14:03', '2003-04-30T12:03:00Z'],
    ['2003-04-30T14:03:11', '2003-04-30T12:03:11Z'],
    ['2003-04-30T14:03:11+05:00', '2003-04-30T09:03:11Z'],
  ];

  for (const [manual, expectedUtc] of cases) {
    await t.step(manual, () => {
      const resolved = resolveTime({ manual, archiveZone: STOCKHOLM })!;
      // The value is stored exactly as typed: its length is its precision, and rewriting it to
      // a full timestamp would be claiming a day and an hour nobody ever knew.
      assertEquals(resolved.takenAt, manual);
      assertEquals(resolved.takenAtUtc, expectedUtc);
    });
  }
});

Deno.test('the resolved pair orders by instant, not by wall clock', () => {
  // A Tokyo noon happened before a Stockholm breakfast four hours later, and only one of the
  // two attrs can say so.
  const tokyo = resolveTime({ gps: parts('2015-07-25T03:00:00'), device: parts('2015-07-25T12:00:00'), archiveZone: STOCKHOLM })!;
  const stockholm = resolveTime({ gps: parts('2015-07-25T06:00:00'), device: parts('2015-07-25T08:00:00'), archiveZone: STOCKHOLM })!;

  assertEquals(tokyo.takenAt, '2015-07-25T12:00:00+09:00');
  assertEquals(stockholm.takenAt, '2015-07-25T08:00:00+02:00');
  assertEquals(tokyo.takenAt > stockholm.takenAt, true);
  assertEquals(tokyo.takenAtUtc < stockholm.takenAtUtc, true);
});

Deno.test('reading the sources back off an exif node', async (t) => {
  await t.step('both dates', () => {
    const when = whenFromExifAttrs({
      when: { device: parts('2015-07-25T14:03:11'), gps: parts('2015-07-25T12:03:11') },
    })!;
    assertEquals(when.device?.hour, '14');
    assertEquals(when.gps?.hour, '12');
  });

  await t.step('a malformed block yields nothing rather than half of itself', () => {
    // Half a `when` would silently demote a GPS-dated file to its camera clock, which looks
    // exactly like a working answer.
    assertEquals(whenFromExifAttrs({ when: null }), {});
    assertEquals(whenFromExifAttrs({ when: 'nope' }), {});
    assertEquals(whenFromExifAttrs({ when: { device: { year: '2015' } } }), { device: undefined, gps: undefined });
  });

  await t.step('no `when` key at all is not the same as an empty one', () => {
    // An exif node without `when` says nothing about the file's date, and a
    // re-resolve must leave that date alone rather than clear it. A `when` that is present and
    // empty is a positive statement that there is no date, and clearing is then correct.
    assertEquals(whenFromExifAttrs({}), undefined);
    assertEquals(whenFromExifAttrs({ indexedAt: '2020-01-01T00:00:00Z' }), undefined);
    assertEquals(whenFromExifAttrs({ when: null }), {});
  });
});

Deno.test('a name dates a file only when nothing else does', async (t) => {
  await t.step('a wall clock in a name is read in the archive zone, or the device registry offset', () => {
    assertEquals(resolveTime({ name: '2019-06-01T12:34:56', archiveZone: STOCKHOLM }), {
      takenAt: '2019-06-01T12:34:56',
      takenAtUtc: '2019-06-01T10:34:56Z',
      takenAtSource: 'name',
    });
    const registered = resolveTime({ name: '2019-06-01T12:34:56', deviceOffsetAt: () => 3 * 3600, archiveZone: STOCKHOLM })!;
    assertEquals([registered.takenAt, registered.takenAtUtc], ['2019-06-01T12:34:56+03:00', '2019-06-01T09:34:56Z']);
  });

  await t.step('a UTC name keeps its instant and reads as the wall clock where it was taken', () => {
    assertEquals(resolveTime({ name: '2019-06-01T10:34:56Z', archiveZone: STOCKHOLM }), {
      takenAt: '2019-06-01T12:34:56+02:00',
      takenAtUtc: '2019-06-01T10:34:56Z',
      takenAtSource: 'name',
    });
  });

  await t.step('a day stays a day', () => {
    assertEquals(resolveTime({ name: '2019-06-01', archiveZone: STOCKHOLM }), { takenAt: '2019-06-01', takenAtUtc: '2019-05-31T22:00:00Z', takenAtSource: 'name' });
  });

  await t.step('every other source outranks it', () => {
    const name = '2001-01-01T00:00:00';
    assertEquals(resolveTime({ name, device: parts('2015-07-25T14:03:11'), archiveZone: STOCKHOLM })!.takenAtSource, 'device');
    assertEquals(resolveTime({ name, gps: parts('2015-07-25T12:03:11'), archiveZone: STOCKHOLM })!.takenAtSource, 'gps');
    assertEquals(resolveTime({ name, manual: '1975', archiveZone: STOCKHOLM })!.takenAtSource, 'manual');
  });
});

Deno.test("a digitized copy is dated by a person only, never by the digitizing's clocks", () => {
  const sources = { gps: parts('2021-03-04T09:00:00'), device: parts('2021-03-04T10:00:00'), name: '2021-03-04T10:00:00', archiveZone: STOCKHOLM };
  assertEquals(resolveTime({ ...sources, digitized: true }), null);
  assertEquals(resolveTime({ ...sources, digitized: true, manual: '1968-07' })!.takenAt, '1968-07');
  assertEquals(resolveTime({ ...sources })!.takenAtSource, 'gps');
});

Deno.test('the stamps on a file are read as sources, and nothing else there is', () => {
  assertEquals(stampedSources({ digitized: true, whenName: '2019-06-01' }), { digitized: true, name: '2019-06-01' });
  assertEquals(stampedSources({ digitized: 'yes', whenName: 'June' }), {});
  assertEquals(stampedSources({ digitized: null, whenName: null }), {});
});

Deno.test("a sidecar's date ranks after a manual one and, for a Takeout instant, by how far it is from the camera", async (t) => {
  const device = parts('2019-06-01T14:34:56');
  const gps = parts('2019-06-01T12:34:50');
  // Google's reading of the camera clock: the same moment, in UTC.
  const read = { instant: '2019-06-01T12:34:56Z', uploaded: '2019-07-01T10:00:00Z' };

  await t.step("an XMP date is a person's: after a manual time, before every clock, at its own precision", () => {
    assertEquals(resolveTime({ manual: '1975', sidecar: { wallClock: '1968-07' }, device, archiveZone: STOCKHOLM })!.takenAtSource, 'manual');
    assertEquals(resolveTime({ sidecar: { wallClock: '1968-07' }, gps, device, archiveZone: STOCKHOLM }), {
      takenAt: '1968-07',
      takenAtUtc: '1968-06-30T23:00:00Z',
      takenAtSource: 'sidecar',
    });
    // An offset it carries is kept; a wall clock without one is read in the archive's zone.
    assertEquals(resolveTime({ sidecar: { wallClock: '2019-06-01T12:34:56+02:00' }, archiveZone: STOCKHOLM })!.takenAtUtc, '2019-06-01T10:34:56Z');
    assertEquals(resolveTime({ sidecar: { wallClock: '2019-06-01T12:34:56' }, archiveZone: STOCKHOLM })!.takenAtUtc, '2019-06-01T10:34:56Z');
  });

  await t.step('a Takeout instant near the camera clock gives the camera clock its offset, after a GPS fix', () => {
    assertEquals(resolveTime({ sidecar: read, gps, device, archiveZone: STOCKHOLM })!.takenAtSource, 'gps');
    assertEquals(resolveTime({ sidecar: read, device, archiveZone: STOCKHOLM }), {
      takenAt: '2019-06-01T14:34:56+02:00',
      takenAtUtc: '2019-06-01T12:34:56Z',
      takenAtSource: 'sidecar',
    });
    // A camera that recorded its own offset says all of it itself.
    assertEquals(resolveTime({ sidecar: read, device: parts('2019-06-01T14:34:56', '+02:00'), archiveZone: STOCKHOLM })!.takenAtSource, 'device');
  });

  await t.step('a Takeout instant days from the camera clock is a date a person set, and beats the GPS fix', () => {
    const set = { instant: '1999-12-24T15:00:00Z', uploaded: read.uploaded };
    assertEquals(resolveTime({ sidecar: set, gps, device, archiveZone: STOCKHOLM }), {
      takenAt: '1999-12-24T15:00:00Z',
      takenAtUtc: '1999-12-24T15:00:00Z',
      takenAtSource: 'sidecar',
    });
  });

  await t.step('with no camera clock, a Takeout instant is believed unless it is the upload', () => {
    assertEquals(resolveTime({ sidecar: read, archiveZone: STOCKHOLM })!.takenAt, '2019-06-01T12:34:56Z');
    assertEquals(resolveTime({ sidecar: { instant: '2019-07-01T09:00:00Z', uploaded: '2019-07-01T10:00:00Z' }, archiveZone: STOCKHOLM }), null);
    assertEquals(resolveTime({ sidecar: { instant: '2019-07-01T09:00:00Z', uploaded: '2019-07-01T10:00:00Z' }, gps, archiveZone: STOCKHOLM })!.takenAtSource, 'gps');
  });

  await t.step('a digitized copy keeps an XMP date and one set in Google Photos, and drops an instant that only reads its clocks', () => {
    assertEquals(resolveTime({ digitized: true, sidecar: { wallClock: '1968' }, device, archiveZone: STOCKHOLM })!.takenAt, '1968');
    assertEquals(resolveTime({ digitized: true, sidecar: { instant: '1999-12-24T15:00:00Z' }, device, archiveZone: STOCKHOLM })!.takenAtSource, 'sidecar');
    assertEquals(resolveTime({ digitized: true, sidecar: read, device, archiveZone: STOCKHOLM }), null);
    // A digitizer's clock is still a clock to measure the instant against.
    assertEquals(resolveTime({ digitizer: true, sidecar: read, device, archiveZone: STOCKHOLM }), null);
  });
});
