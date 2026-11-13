/**
 * A camera whose clock was wrong rather than set to another zone: `clockOffset` settings in its
 * `configuration` log put the reading right before it is read in a zone, from the date each
 * took effect, and `--clock-offset` text reads and writes the same seconds.
 */

import { assertEquals } from '@std/assert';
import { type CameraClock, clockErrorAt, type ClockSetting, clockSources, offsetAt } from '@archive/camera/camera-zone';
import { formatClockOffset, parseClockOffset } from '@archive/camera/clock-offset';
import { resolveTime } from '@archive/media/capture-resolve';

const STOCKHOLM = 'Europe/Stockholm';
const DAY_AHEAD = 23 * 3600 + 2 * 60;

const at = (iso: string) => Date.parse(`${iso}Z`);
const clock = (history: ClockSetting[], timezone?: string): CameraClock => ({ history, ...(timezone ? { timezone } : {}) });

/** `2017-07-26T14:00:00` as exif parts. */
const parts = (iso: string) => {
  const [date, time] = iso.split('T');
  const [year, month, day] = date.split('-');
  const [hour, minute, second] = time.split(':');
  return { year, month, day, hour, minute, second };
};

Deno.test('clock offsets read and write as signed days, hours, minutes and seconds', () => {
  assertEquals(parseClockOffset('+23h 2m'), DAY_AHEAD);
  assertEquals(parseClockOffset('23h2m'), DAY_AHEAD);
  assertEquals(parseClockOffset('-5m'), -300);
  assertEquals(parseClockOffset('1d 30s'), 86_430);
  assertEquals(parseClockOffset('0'), 0);
  assertEquals(parseClockOffset('5'), undefined);
  assertEquals(parseClockOffset('2h 3h'), undefined);
  assertEquals(parseClockOffset('soon'), undefined);
  assertEquals(formatClockOffset(DAY_AHEAD), '+23h 2m');
  assertEquals(formatClockOffset(-300), '-5m');
  assertEquals(formatClockOffset(0), '0');
});

Deno.test('a clock offset is in force from its date, for the moment the reading is put right to', () => {
  const wrong = clock([{ from: 0, clockOffset: DAY_AHEAD }, { from: at('2017-08-01T00:00:00'), clockOffset: 0 }]);
  assertEquals(clockErrorAt(wrong, '2017-07-26T14:00:00'), DAY_AHEAD);
  assertEquals(clockErrorAt(wrong, '2017-08-10T10:00:00'), 0);
  // Set a day ahead from 1 August, its reading of noon that day is from before: put right, it is 31 July.
  const later = clock([{ from: 0, clockOffset: 0 }, { from: at('2017-08-01T00:00:00'), clockOffset: DAY_AHEAD }]);
  assertEquals(clockErrorAt(later, '2017-08-01T12:00:00'), 0);
  assertEquals(clockErrorAt(later, '2017-08-02T12:00:00'), DAY_AHEAD);
  assertEquals(clockErrorAt(clock([]), '2017-07-26T14:00:00'), 0);
  // One for all its pictures covers those from before 1970 too.
  assertEquals(clockErrorAt(wrong, '1965-07-26T14:00:00'), DAY_AHEAD);
  // A fixed offset says nothing about the clock being wrong.
  assertEquals(clockErrorAt(clock([{ from: 0, utcOffset: 3600, autoDst: false }]), '2017-07-26T14:00:00'), 0);
});

Deno.test('a clock offset reads the clock in its timezone, else the archive zone, over an older fixed offset', () => {
  const fixed = { from: 0, utcOffset: 3600, autoDst: false };
  assertEquals(offsetAt(clock([fixed]), '2017-07-25T14:58:00', STOCKHOLM), 3600);
  assertEquals(offsetAt(clock([fixed, { from: 0, clockOffset: DAY_AHEAD }]), '2017-07-25T14:58:00', STOCKHOLM), undefined);
  assertEquals(offsetAt(clock([{ from: 0, clockOffset: DAY_AHEAD }], 'Europe/London'), '2017-07-25T14:58:00', STOCKHOLM), 3600);
});

Deno.test('a camera reading a day ahead is put right, then read in its zone', async (t) => {
  const sources = clockSources(clock([{ from: 0, clockOffset: DAY_AHEAD }]), STOCKHOLM);

  await t.step('the camera clock', () => {
    const resolved = resolveTime({ camera: parts('2017-07-26T14:00:00'), ...sources })!;
    assertEquals(resolved.takenAt, '2017-07-25T14:58:00');
    assertEquals(resolved.takenAtUtc, '2017-07-25T12:58:00Z');
    assertEquals(resolved.takenAtSource, 'camera');
  });

  await t.step('a GPS fix is checked against the clock put right, and stamps its zone', () => {
    const resolved = resolveTime({ camera: parts('2017-07-26T14:00:00'), gps: parts('2017-07-25T12:58:00'), ...sources })!;
    assertEquals(resolved.takenAtSource, 'gps');
    assertEquals(resolved.takenAt, '2017-07-25T14:58:00+02:00');
  });

  await t.step('a name the camera gave the file', () => {
    const resolved = resolveTime({ name: '2017-07-26T14:00:00', ...sources })!;
    assertEquals(resolved.takenAt, '2017-07-25T14:58:00');
    assertEquals(resolved.takenAtSource, 'name');
  });

  await t.step("a Takeout instant near the clock is Google's reading of it, and put right too", () => {
    const resolved = resolveTime({ camera: parts('2017-07-26T14:00:00'), sidecar: { instant: '2017-07-26T12:00:00Z' }, ...sources })!;
    assertEquals(resolved.takenAtUtc, '2017-07-25T12:58:00Z');
    assertEquals(resolved.takenAt, '2017-07-25T14:58:00+02:00');
  });

  await t.step('a manual time is left as a person gave it', () => {
    assertEquals(resolveTime({ manual: '2017-07-26T14:00:00', camera: parts('2017-07-26T14:00:00'), ...sources })!.takenAt, '2017-07-26T14:00:00');
  });
});
