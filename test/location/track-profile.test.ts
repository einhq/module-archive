/** Track profiles: a camera's kind picks its thresholds and the units its track is shown in. */

import { assertEquals } from '@std/assert';
import { formatDistance, formatSpeed, trackProfile } from '@archive/location/track-profile';

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
