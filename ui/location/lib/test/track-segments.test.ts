/** A track's speed is read while it moves, not while it lies still, jumps or stops recording. */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { trackProfile } from '@archive/location/track-profile';
import { movingSpeed } from '../track-segments.ts';

Deno.test('the moving speed leaves out lying still, glitches and gaps', () => {
  const at = (minutes: number) => new Date(Date.UTC(2020, 5, 1, 10, minutes)).toISOString();
  // About 0.01° of latitude, 1112 m, in ten minutes: 1.85 m/s.
  const points = [
    { lat: 57.00, lng: 11.9, ts: at(0) },
    { lat: 57.01, lng: 11.9, ts: at(10) },
    { lat: 57.01, lng: 11.9, ts: at(40) }, // still for half an hour
    { lat: 57.02, lng: 11.9, ts: at(50) },
    { lat: 58.02, lng: 11.9, ts: at(51) }, // a glitch, 111 km in a minute
  ];
  const speed = movingSpeed([{ day: '2020-06-01', points }], trackProfile('boat'));
  assertAlmostEquals(speed!, (2 * 1112) / 1200, 0.01);

  // Two fixes a day apart are a gap in the recording, not a slow passage.
  const gap = [{ lat: 57, lng: 11.9, ts: at(0) }, { lat: 57.1, lng: 11.9, ts: new Date(Date.UTC(2020, 5, 2, 10)).toISOString() }];
  assertEquals(movingSpeed([{ day: '2020-06-01', points: gap }], trackProfile('boat')), undefined);
});
