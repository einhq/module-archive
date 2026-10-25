import { assertAlmostEquals, assertEquals } from '@std/assert';
import { boxAt, parseTrack, type TrackPoint } from '../face-track.ts';

const TRACK: TrackPoint[] = [
  [1, 0.1, 0.2, 0.1, 0.2],
  [2, 0.3, 0.2, 0.1, 0.2],
  [10, 0.6, 0.4, 0.2, 0.3],
];
const APPEARANCES: [number, number][] = [[0.5, 2.5], [9.5, 10.5]];
// Seen for a moment, then unseen for two seconds — turned away — and seen again, all one appearance.
const TURNED: TrackPoint[] = [
  [27, 0.76, 0.6, 0.11, 0.25],
  [27.25, 0.75, 0.63, 0.12, 0.21],
  [29.5, 0.39, 0.54, 0.04, 0.11],
  [29.75, 0.36, 0.55, 0.04, 0.1],
];

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

Deno.test('where the face went unseen the box stays a moment at each end and is otherwise gone', () => {
  const appearance: [number, number][] = [[26.5, 30]];
  assertEquals(boxAt(TURNED, appearance, 27.4), { x: 0.75, y: 0.63, width: 0.12, height: 0.21 });
  assertEquals(boxAt(TURNED, appearance, 28.5), undefined);
  assertEquals(boxAt(TURNED, appearance, 29.3), { x: 0.39, y: 0.54, width: 0.04, height: 0.11 });
  // A second's step is the face seen throughout, and slid across as before.
  assertAlmostEquals(boxAt([[1, 0.1, 0.2, 0.1, 0.2], [2, 0.3, 0.2, 0.1, 0.2]], [[0.5, 2.5]], 1.5)!.x, 0.2);
});
