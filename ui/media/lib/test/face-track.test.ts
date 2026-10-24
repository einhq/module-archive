import { assertAlmostEquals, assertEquals } from '@std/assert';
import { boxAt, parseTrack, type TrackPoint } from '../face-track.ts';

const TRACK: TrackPoint[] = [
  [1, 0.1, 0.2, 0.1, 0.2],
  [2, 0.3, 0.2, 0.1, 0.2],
  [10, 0.6, 0.4, 0.2, 0.3],
];
const APPEARANCES: [number, number][] = [[0.5, 2.5], [9.5, 10.5]];

Deno.test('a track file is read a line a sighting, in time order, past lines that are not one', () => {
  const text = '[2,0.3,0.2,0.1,0.2]\n[1,0.1,0.2,0.1,0.2]\nnot json\n[3,1]\n\n';
  assertEquals(parseTrack(text), [[1, 0.1, 0.2, 0.1, 0.2], [2, 0.3, 0.2, 0.1, 0.2]]);
});

Deno.test('between two sightings the box slides from one to the next', () => {
  const box = boxAt(TRACK, APPEARANCES, 1.25)!;
  assertAlmostEquals(box.x, 0.15);
  assertEquals([box.y, box.width, box.height], [0.2, 0.1, 0.2]);
  assertEquals(boxAt(TRACK, APPEARANCES, 2), { x: 0.3, y: 0.2, width: 0.1, height: 0.2 });
});

Deno.test('at the edges of an appearance the box stays on the nearest sighting', () => {
  assertEquals(boxAt(TRACK, APPEARANCES, 0.6), { x: 0.1, y: 0.2, width: 0.1, height: 0.2 });
  assertEquals(boxAt(TRACK, APPEARANCES, 10.4), { x: 0.6, y: 0.4, width: 0.2, height: 0.3 });
});

Deno.test('off screen there is no box, and a gap between appearances is not bridged', () => {
  assertEquals(boxAt(TRACK, APPEARANCES, 0.2), undefined);
  assertEquals(boxAt(TRACK, APPEARANCES, 5), undefined);
  assertEquals(boxAt(TRACK, APPEARANCES, 11), undefined);
});
