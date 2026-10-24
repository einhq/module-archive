/**
 * Time trust per category: for every kind's preset and every combination of the sources a file can
 * have (a person's date, a GPS fix, the device's clock, a date in its name), the source that dates
 * it, through the stamps the kind gives it (`timeStamps`) and the resolver.
 */
import { assertEquals } from '@std/assert';
import type { CaptureDateParts } from '@archive/media/capture-resolve';
import { resolveTime, stampedSources } from '@archive/media/capture-resolve';
import { CATEGORY_KINDS, presetSettings, sameTimeRules, stampsHold, timeStamps } from '@archive/staging/category';

const STOCKHOLM = 'Europe/Stockholm';
const parts = (iso: string): CaptureDateParts => {
  const [date, time] = iso.split('T');
  const [year, month, day] = date.split('-');
  const [hour, minute, second] = time.split(':');
  return { year, month, day, hour, minute, second };
};

const SOURCES = ['manual', 'gps', 'device', 'name'] as const;
type Source = typeof SOURCES[number];

/** Which source dates a file of a category with `digitized` and `filenameDates`, holding `held`. */
const expected = (held: Set<Source>, rules: { digitized: boolean; filenameDates: boolean }): Source | null => {
  if (held.has('manual')) return 'manual';
  if (rules.digitized) return null;
  for (const source of ['gps', 'device'] as const) if (held.has(source)) return source;
  return held.has('name') && rules.filenameDates ? 'name' : null;
};

Deno.test('every kind dates every combination of sources by its rules', () => {
  const table: string[] = [];
  for (const kind of CATEGORY_KINDS) {
    const rules = presetSettings(kind, kind).time;
    for (let mask = 0; mask < 16; mask++) {
      const held = new Set(SOURCES.filter((_, i) => mask & (1 << i)));
      // A name that spells a date, or one that does not.
      const stamps = timeStamps(rules, held.has('name') ? 'IMG_20190601_123456.jpg' : 'IMG_0001.jpg');
      const resolved = resolveTime({
        ...(held.has('manual') ? { manual: '1968-07' } : {}),
        ...(held.has('gps') ? { gps: parts('2021-03-04T09:00:00') } : {}),
        ...(held.has('device') ? { device: parts('2021-03-04T10:00:00') } : {}),
        archiveZone: STOCKHOLM,
        ...stampedSources(stamps),
      });
      const got = resolved?.takenAtSource ?? null;
      const want = expected(held, rules);
      if (got !== want) table.push(`${kind} [${[...held].join(', ')}]: ${got}, expected ${want}`);
    }
  }
  assertEquals(table, []);
});

Deno.test('a scan never takes a date from the scanner: its clock, a GPS fix or its name', () => {
  const rules = presetSettings('scans', 'box-3').time;
  const stamps = timeStamps(rules, 'IMG_20210304_100000.jpg');
  assertEquals(stamps, { digitized: true, whenName: null });
  // DateTimeOriginal written on the scan day, a scanning app's GPS fix: no capture time.
  const scanDay = { gps: parts('2021-03-04T09:00:00'), device: parts('2021-03-04T10:00:00'), archiveZone: STOCKHOLM };
  assertEquals(resolveTime({ ...scanDay, ...stampedSources(stamps) }), null);
  // The same file in a camera's category is dated by its clock.
  assertEquals(resolveTime({ ...scanDay, ...stampedSources(timeStamps(presetSettings('camera', 'camera').time, 'IMG_0001.jpg')) })?.takenAtSource, 'gps');
});

Deno.test('stamps are what the rules give a name, and hold only when the file carries exactly them', () => {
  const inbox = presetSettings('inbox', 'inbox').time;
  assertEquals(timeStamps(inbox, '2019-06-01 12.34.56.jpg'), { digitized: null, whenName: '2019-06-01T12:34:56' });
  assertEquals(timeStamps(inbox, 'IMG_0001.jpg'), { digitized: null, whenName: null });
  assertEquals(timeStamps(presetSettings('camera', 'camera').time, '2019-06-01 12.34.56.jpg'), { digitized: null, whenName: null });
  const stamps = timeStamps(inbox, 'PXL_20190601_103456789.jpg');
  assertEquals(stampsHold({ whenName: '2019-06-01T10:34:56Z' }, stamps), true);
  assertEquals(stampsHold({ whenName: '2019-06-01T10:34:56Z', digitized: true }, stamps), false);
  assertEquals(stampsHold({}, stamps), false);
  assertEquals(stampsHold({}, { digitized: null, whenName: null }), true);
  assertEquals(sameTimeRules(presetSettings('phone', 'p').time, inbox), true);
  assertEquals(sameTimeRules(presetSettings('scans', 's').time, inbox), false);
});
