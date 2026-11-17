/** Track profiles: a track's kind picks its thresholds and the units it is shown in; a trip's kind can come from its device's activity. */

import { assertEquals } from '@std/assert';
import { activityKind, formatDistance, formatSpeed, trackProfile, tripKindLabel } from '@archive/location/track-profile';

Deno.test('a boat is nautical, everything else metric, and no kind reads as a car', () => {
  assertEquals(trackProfile('boat').units, 'nautical');
  assertEquals(trackProfile('foot').units, 'metric');
  assertEquals(trackProfile(undefined), trackProfile('car'));
  assertEquals(trackProfile('submarine'), trackProfile('car'));
});

Deno.test('distances and speeds are shown in the units of the kind', () => {
  assertEquals(formatDistance(1852 * 12.4, 'nautical'), '12.4 nm');
  assertEquals(formatDistance(23000, 'metric'), '23.0 km');
  assertEquals(formatDistance(500, 'metric'), '0.50 km');
  assertEquals(formatSpeed(1852 / 3600 * 5.2, 'nautical'), '5.2 kn');
  assertEquals(formatSpeed(1000 / 3600 * 48, 'metric'), '48 km/h');
  assertEquals(formatSpeed(1000 / 3600 * 4.5, 'metric'), '4.5 km/h');
});

Deno.test('activityKind: the kind said longest over the span, each entry holding until the next, still counting for none', () => {
  const log = [
    { at: 0, activity: 'in_vehicle' },
    { at: 100, activity: 'still' },
    { at: 200, activity: 'on_foot' },
    { at: 260, activity: 'running' },
    { at: 300, activity: 'on_bicycle' },
  ];
  // The ride before the span holds from its start until it is still; walking and running are both on foot.
  assertEquals(activityKind(log, 50, 330), 'foot');
  assertEquals(activityKind(log, 50, 420), 'bike');
  assertEquals(activityKind(log, 0, 210), 'car');
  assertEquals(activityKind(log, 120, 190), undefined, 'still all the way');
  assertEquals(activityKind([{ at: 0, activity: 'tilting' }, { at: 10, activity: 'toString' }], 0, 100), undefined, 'what names no kind');
  assertEquals(activityKind([], 0, 100), undefined);
});

Deno.test('a trip kind is named, and one its device sensed says so', () => {
  assertEquals(tripKindLabel({ kind: 'foot' }), 'On foot');
  assertEquals(tripKindLabel({ kind: 'bike', sensed: true }), 'Bike (by its motion sensors)');
  assertEquals(tripKindLabel({}), undefined);
});
