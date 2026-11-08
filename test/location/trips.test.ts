/**
 * How a track is cut into trips, legs and stays: where trips end, where their destination is,
 * how they are cut into local days, when one is ongoing, how edits change the cut, and that
 * reading again from `settledUntil` reproduces the rest. The tracks are invented, laid out
 * north of an arbitrary point at sea.
 */

import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { segmentTrips, type TripFix, type TripSettings } from '@archive/location/trips';

const BASE_LAT = 59.0;
const BASE_LNG = 18.0;
const M2DEG = 1 / 111_320;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2025-06-01T00:00:00Z. */
const T0 = Date.UTC(2025, 5, 1);

const SETTINGS: TripSettings = { clusterRadiusM: 1000, longRestMs: 3 * DAY, now: T0 + 400 * DAY };

/** A fix on day index `d` at UTC hour `h`, `northM` metres north of the base. */
function fix(d: number, h: number, northM: number): TripFix {
  return { ms: T0 + d * DAY + h * HOUR, lat: BASE_LAT + northM * M2DEG, lng: BASE_LNG };
}

/** Lying at `northM` for `days` days from day index `d`, a fix every six hours. */
function rest(d: number, days: number, northM: number): TripFix[] {
  const out: TripFix[] = [];
  for (let i = 0; i < days; i++) for (const h of [0, 6, 12, 18]) out.push(fix(d + i, h, northM));
  return out;
}

/** From `fromM` to `toM` metres north on day `d`, a fix an hour from 09:00. */
function out(d: number, fromM: number, toM: number, steps = 4): TripFix[] {
  return Array.from({ length: steps }, (_, i) => fix(d, 9 + i, fromM + ((toM - fromM) * (i + 1)) / steps));
}

const northOf = (p: { lat: number }) => (p.lat - BASE_LAT) / M2DEG;

Deno.test('the destination is the farthest stay, not the farthest fix', () => {
  const seg = segmentTrips([
    ...rest(0, 4, 0),
    // Out to 10 km, back to 8.2 km and the night there.
    ...out(4, 0, 10_000),
    fix(4, 14, 8200),
    fix(4, 18, 8210),
    fix(4, 22, 8190),
    fix(5, 2, 8205),
    fix(5, 6, 8195),
    // Home again.
    fix(5, 9, 5000),
    fix(5, 10, 2500),
    fix(5, 11, 0),
    ...rest(6, 4, 0),
  ], SETTINGS);
  assertEquals(seg.trips.length, 1);
  const trip = seg.trips[0];
  assertAlmostEquals(northOf(trip.destination), 8200, 100);
  assertEquals(seg.stays[trip.destination.stay!].kind, 'overnight');
  assertAlmostEquals(trip.maxDistanceM, 10_000, 50);
  assertEquals(trip.days, ['2025-06-05', '2025-06-06']);
  assertEquals(trip.legs.length, 2);
  // The first leg ends on the night's stay, and the second starts there.
  assertEquals(trip.legs[0].to.stay, trip.destination.stay);
  assertEquals(trip.legs[1].from.stay, trip.destination.stay);
  assertEquals(seg.stays[trip.from.stay!].kind, 'rest');
  assertEquals(seg.stays[trip.to.stay!].kind, 'rest');
});

Deno.test('a day out and back without stays has the farthest fix as its destination', () => {
  const seg = segmentTrips([...rest(0, 4, 0), ...out(4, 0, 10_000), ...out(4, 10_000, 0).map((f) => ({ ...f, ms: f.ms + 4 * HOUR })), ...rest(5, 4, 0)], SETTINGS);
  assertEquals(seg.trips.length, 1);
  assertAlmostEquals(northOf(seg.trips[0].destination), 10_000, 100);
  assertEquals(seg.trips[0].destination.stay, undefined);
  assertEquals(seg.trips[0].legs.length, 1);
});

Deno.test('a trip that never gets 500 m from its start is dropped', () => {
  const seg = segmentTrips([...rest(0, 4, 0), fix(4, 9, 1200), fix(4, 10, 1500), fix(4, 11, 1300), ...rest(5, 4, 1200)], SETTINGS);
  assertEquals(seg.trips.length, 0);
});

Deno.test('a long gap without fixes ends a trip where the camera was last seen', () => {
  const seg = segmentTrips([...rest(0, 4, 0), ...out(4, 0, 10_000), ...out(20, 10_000, 20_000)], SETTINGS);
  assertEquals(seg.trips.length, 2);
  assertAlmostEquals(northOf(seg.trips[0].to), 10_000, 1);
  assertEquals(seg.trips[0].to.stay, undefined);
  assertEquals(seg.trips[0].ongoing, false);
  assertAlmostEquals(northOf(seg.trips[1].from), 12_500, 1);
  // Reading again starts at the fix after the gap.
  assertEquals(seg.settledUntil, fix(20, 9, 0).ms);
});

Deno.test('arriving home ends a trip, however short the stay', () => {
  const home = { lat: BASE_LAT, lng: BASE_LNG, path: '/archive/locations/the-berth' };
  const fixes = [
    ...rest(0, 1, 0),
    ...out(1, 0, 10_000),
    ...out(1, 10_000, 0).map((f) => ({ ...f, ms: f.ms + 4 * HOUR })),
    // An hour at home, then out again the same day.
    fix(1, 18, 0),
    fix(1, 19, 0),
    fix(1, 20, 5000),
    fix(1, 21, 6000),
    fix(1, 22, 0),
  ];
  const seg = segmentTrips(fixes, { ...SETTINGS, homes: [home] });
  assertEquals(seg.trips.map((t) => t.id), ['2025-06-02', '2025-06-02-2']);
  const arrived = seg.stays[seg.trips[0].to.stay!];
  assertEquals(arrived.kind, 'home');
  assertEquals(arrived.home, home.path);
  assertEquals(seg.trips[1].from.stay, seg.trips[0].to.stay);
  // The track ends at home: the second trip has ended, though only a fix ago.
  assertEquals(seg.stays[seg.trips[1].to.stay!].kind, 'home');
  // Without homes, it is one trip (the hour at home is no long rest).
  assertEquals(segmentTrips(fixes, SETTINGS).trips.length, 1);
});

Deno.test('a home counts only within its span', () => {
  const fixes = [...rest(0, 4, 0), ...out(4, 0, 10_000), fix(4, 15, 5000), fix(4, 16, 0), fix(4, 18, 0)];
  const span = (from?: string, to?: string) => [{ lat: BASE_LAT, lng: BASE_LNG, path: '/archive/locations/the-house', from, to }];
  const ended = (homes: ReturnType<typeof span>) => segmentTrips(fixes, { ...SETTINGS, homes }).trips[0].to.stay !== undefined;
  assertEquals(ended(span('2025', '2025')), true);
  assertEquals(ended(span('2025-06-05')), true);
  assertEquals(ended(span(undefined, '2025-05')), false);
  assertEquals(ended(span('2025-06-06')), false);
});

Deno.test('passing a home on the way does not end a trip', () => {
  const home = { lat: BASE_LAT + 5000 * M2DEG, lng: BASE_LNG, path: '/archive/locations/the-house' };
  // 500 m every ten minutes: no cluster lasts half an hour.
  const passage = Array.from({ length: 20 }, (_, i) => ({ ...fix(4, 9, 500 * (i + 1)), ms: fix(4, 9, 0).ms + i * 10 * 60_000 }));
  const seg = segmentTrips([...rest(0, 4, 0), ...passage, ...rest(5, 4, 10_000)], { ...SETTINGS, homes: [home] });
  assertEquals(seg.trips.length, 1);
  assert(seg.stays.every((stay) => stay.kind !== 'home'));
});

Deno.test('legs follow the local day of the camera', () => {
  // At UTC+2, 21:00 UTC is still 2025-06-05 and 23:00 UTC already the 6th.
  const fixes = [...rest(0, 4, 0), fix(4, 21, 2000), fix(4, 23, 6000), fix(5, 1, 9000), fix(5, 3, 12_000), ...rest(6, 4, 12_000)];
  const utc = segmentTrips(fixes, SETTINGS).trips[0];
  assertEquals(utc.days, ['2025-06-05', '2025-06-06']);
  assertEquals(utc.legs[0].end, new Date(fix(4, 23, 0).ms).toISOString());
  const local = segmentTrips(fixes, { ...SETTINGS, timezone: 'Europe/Stockholm' }).trips[0];
  assertEquals(local.days, ['2025-06-05', '2025-06-06']);
  assertEquals(local.legs[0].end, new Date(fix(4, 21, 0).ms).toISOString());
});

Deno.test('the stretch across midnight counts towards the trip and the day it ends on', () => {
  const fixes = [...rest(0, 4, 0), fix(4, 22, 2000), fix(4, 23, 6000), fix(5, 1, 9000), fix(5, 2, 12_000), ...rest(6, 4, 12_000)];
  const trip = segmentTrips(fixes, SETTINGS).trips[0];
  assertEquals(trip.days, ['2025-06-05', '2025-06-06']);
  assertAlmostEquals(trip.legs[0].distanceM, 4000, 20);
  assertAlmostEquals(trip.legs[1].distanceM, 3000, 20);
  assertAlmostEquals(trip.distanceM, 7000, 20);
});

Deno.test('a trip is ongoing while it has not ended and its last fix is recent', () => {
  const fixes = [...rest(0, 4, 0), ...out(4, 0, 10_000)];
  const last = fixes[fixes.length - 1].ms;
  assertEquals(segmentTrips(fixes, { ...SETTINGS, now: last + 47 * HOUR }).trips[0].ongoing, true);
  assertEquals(segmentTrips(fixes, { ...SETTINGS, now: last + 49 * HOUR }).trips[0].ongoing, false);
  // Ended at a long rest, it is over whatever the time.
  const ended = segmentTrips([...fixes, ...rest(5, 4, 10_000)], { ...SETTINGS, now: last + HOUR });
  assertEquals(ended.trips[0].ongoing, false);
});

Deno.test('a merge joins trips across a long rest, and the rest stays a stay', () => {
  const fixes = [
    ...rest(0, 4, 0),
    ...out(4, 0, 10_000),
    ...rest(5, 4, 10_000),
    ...out(9, 10_000, 20_000),
    ...rest(10, 4, 20_000),
  ];
  const auto = segmentTrips(fixes, SETTINGS);
  assertEquals(auto.trips.length, 2);

  const seg = segmentTrips(fixes, { ...SETTINGS, edits: { merge: [auto.trips[1].start] } });
  assertEquals(seg.trips.length, 1);
  const trip = seg.trips[0];
  assertEquals(trip.days, ['2025-06-05', '2025-06-10']);
  assertEquals(trip.joined, [auto.trips[1].start]);
  assertAlmostEquals(northOf(trip.destination), 20_000, 100);
  assert(seg.stays.some((stay) => stay.kind === 'rest' && Math.abs(northOf(stay) - 10_000) < 100));
});

Deno.test('a split starts a trip at a local midnight', () => {
  const fixes = [...rest(0, 4, 0), ...out(4, 0, 10_000), fix(4, 20, 10_000), fix(5, 4, 10_000), ...out(5, 10_000, 20_000), ...rest(6, 4, 20_000)];
  assertEquals(segmentTrips(fixes, SETTINGS).trips.length, 1);
  const seg = segmentTrips(fixes, { ...SETTINGS, edits: { split: ['2025-06-06'] } });
  assertEquals(seg.trips.map((t) => t.id), ['2025-06-05', '2025-06-06']);
  // Both meet on the night's stay.
  assertEquals(seg.trips[0].to.stay, seg.trips[1].from.stay);
  assertEquals(seg.stays[seg.trips[0].to.stay!].kind, 'overnight');
});

Deno.test('reading again from settledUntil reproduces the trips after it', () => {
  const fixes = [
    ...rest(0, 4, 0),
    ...out(4, 0, 10_000),
    ...rest(5, 4, 10_000),
    ...out(9, 10_000, 20_000),
    fix(9, 20, 20_000),
    fix(10, 4, 20_000),
    ...out(10, 20_000, 30_000),
  ];
  const full = segmentTrips(fixes, SETTINGS);
  assertEquals(full.trips.length, 2);
  assertEquals(full.settledUntil, Date.parse(full.stays[full.trips[1].from.stay!].start));

  const again = segmentTrips(fixes.filter((f) => f.ms >= full.settledUntil!), SETTINGS);
  const keptStays = full.stays.filter((stay) => Date.parse(stay.start) < full.settledUntil!).length;
  const shift = (n?: number) => n === undefined ? undefined : n + keptStays;
  assertEquals(again.trips.length, 1);
  assertEquals(again.trips[0].start, full.trips[1].start);
  assertEquals(again.trips[0].distanceM, full.trips[1].distanceM);
  assertEquals(shift(again.trips[0].from.stay), full.trips[1].from.stay);
  assertEquals(shift(again.trips[0].destination.stay), full.trips[1].destination.stay);
  assertEquals(again.stays, full.stays.slice(keptStays));
});

Deno.test('a home held briefly at the end of the track does not settle the trip before it', () => {
  const home = { lat: BASE_LAT, lng: BASE_LNG, path: '/archive/locations/the-berth' };
  const fixes = [...rest(0, 4, 0), ...out(4, 0, 10_000), fix(4, 15, 5000), fix(4, 16, 0)];
  const seg = segmentTrips(fixes, { ...SETTINGS, homes: [home] });
  assertEquals(seg.trips.length, 1);
  assertEquals(seg.stays[seg.trips[0].to.stay!].kind, 'home');
  // The settled point is still the stay the trip left from.
  assertEquals(seg.settledUntil, Date.parse(seg.stays[seg.trips[0].from.stay!].start));
});
