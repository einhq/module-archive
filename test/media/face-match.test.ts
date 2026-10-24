/**
 * Pure-unit tests for face box matching. Fast tier: no VFS, no models.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { type Box, contains, coverage, DEFAULT_MIN_SCALE, iou, matchFacesUnique } from '../../lib/media/face-match.ts';

/** The matcher's whole job is deciding what *not* to pair, so both halves are asserted. */
const match = (manual: Box[], auto: Box[], margin = 0) => matchFacesUnique(manual, auto, { margin });

Deno.test('iou is 1 for identical boxes and 0 for disjoint ones', () => {
  const b: Box = { x: 10, y: 10, width: 40, height: 40 };
  assertEquals(iou(b, b), 1);
  assertEquals(iou(b, { x: 200, y: 200, width: 40, height: 40 }), 0);
  // Touching edges share no area.
  assertEquals(iou(b, { x: 50, y: 10, width: 40, height: 40 }), 0);
});

Deno.test('iou halves as boxes half-overlap', () => {
  const a: Box = { x: 0, y: 0, width: 10, height: 10 };
  const b: Box = { x: 5, y: 0, width: 10, height: 10 };
  // intersection 50, union 150
  assertAlmostEquals(iou(a, b), 1 / 3, 1e-9);
});

Deno.test('coverage measures the inner box, not the union', () => {
  const outer: Box = { x: 0, y: 0, width: 100, height: 100 };
  const inner: Box = { x: 40, y: 40, width: 20, height: 20 };
  assertEquals(coverage(inner, outer), 1);
  // The reverse is the outer box barely covered by the inner one.
  assertAlmostEquals(coverage(outer, inner), 0.04, 1e-9);
  assertEquals(coverage({ x: 0, y: 0, width: 0, height: 10 }, outer), 0);
});

Deno.test('contains is every corner inside, edges included', () => {
  const outer: Box = { x: 0, y: 0, width: 100, height: 100 };
  assertEquals(contains(outer, outer), true, 'a box contains itself');
  assertEquals(contains(outer, { x: 0, y: 0, width: 100, height: 100.000000001 }), true, 'rounding noise is not a corner outside');
  assertEquals(contains(outer, { x: 90, y: 90, width: 20, height: 20 }), false, 'one corner out is out');
  assertEquals(contains(outer, { x: -1, y: 50, width: 10, height: 10 }), false);
  assertEquals(contains(outer, { x: 10, y: 10, width: 0, height: 10 }), false, 'a degenerate box is nowhere');
  // The margin is a fraction of the outer box: 10% of 100 lets an edge sit 10 out.
  assertEquals(contains(outer, { x: 90, y: 90, width: 20, height: 20 }, 0.1), true);
  assertEquals(contains(outer, { x: 90, y: 90, width: 21, height: 20 }, 0.1), false);
});

Deno.test('a tight detection inside a loose manual box is matched', () => {
  // The legacy case: a hand-drawn box around the whole head, and InsightFace's
  // tight box on the face.
  const manual: Box = { x: 0, y: 0, width: 100, height: 100 };
  const auto: Box = { x: 30, y: 30, width: 40, height: 40 };

  const { matches, ambiguous } = match([manual], [auto]);
  assertEquals(ambiguous, []);
  assertEquals(matches.length, 1);
  assertEquals(matches[0], { manualIndex: 0, autoIndex: 0, score: 1, iou: iou(manual, auto), coverage: 1 });
});

Deno.test('non-overlapping boxes are not matched', () => {
  const manual: Box = { x: 0, y: 0, width: 50, height: 50 };
  const auto: Box = { x: 500, y: 500, width: 50, height: 50 };
  const { matches, ambiguous } = match([manual], [auto]);
  assertEquals(matches, []);
  assertEquals(ambiguous, [{ manualIndex: 0, reason: 'none' }]);
});

Deno.test('a detection with a corner outside the tag is not a candidate, however much it overlaps', () => {
  // IoU 0.8 and coverage 0.9 would have taken this pair. A loose box does not
  // cut through the face it was drawn around, so this face is a neighbour's.
  const manual: Box = { x: 0, y: 0, width: 100, height: 100 };
  const auto: Box = { x: 10, y: 10, width: 100, height: 100 };
  const { matches, ambiguous } = match([manual], [auto]);
  assertEquals(matches, []);
  assertEquals(ambiguous, [{ manualIndex: 0, reason: 'none' }]);
  // Unless a margin is asked for.
  assertEquals(match([manual], [auto], 0.1).matches.length, 1);
});

Deno.test('a margin match records how much of the detection was inside', () => {
  const manual: Box = { x: 0, y: 0, width: 100, height: 100 };
  const auto: Box = { x: 60, y: 0, width: 50, height: 100 }; // 10 of 50 columns outside
  const { matches } = match([manual], [auto], 0.1);
  assertEquals(matches.length, 1);
  assertAlmostEquals(matches[0].score, 0.8, 1e-9);
  assertAlmostEquals(matches[0].coverage, 0.8, 1e-9);
});

Deno.test('two tags with a detection each are both matched', () => {
  const manual: Box[] = [
    { x: 0, y: 0, width: 60, height: 60 },
    { x: 40, y: 0, width: 60, height: 60 },
  ];
  const auto: Box[] = [
    { x: 5, y: 5, width: 40, height: 40 },
    { x: 55, y: 5, width: 40, height: 40 },
  ];

  const { matches, ambiguous } = match(manual, auto);
  assertEquals(ambiguous, []);
  assertEquals(matches.length, 2);
  const pairs = matches.map((m) => [m.manualIndex, m.autoIndex]).sort();
  assertEquals(pairs, [[0, 0], [1, 1]]);
});

Deno.test('two tags picking one detection are both left alone', () => {
  // One of these two people is not in that box and nothing here can tell
  // which, so a guess would be a coin flip written to the database as fact —
  // and the tag it consumed is then deleted.
  const manual: Box[] = [
    { x: 0, y: 0, width: 200, height: 200 }, // sloppy, covers it
    { x: 40, y: 40, width: 50, height: 50 }, // snug around the detection
  ];
  const auto: Box[] = [{ x: 45, y: 45, width: 40, height: 40 }];

  const { matches, ambiguous } = match(manual, auto);
  assertEquals(matches, []);
  assertEquals(ambiguous, [
    { manualIndex: 0, reason: 'multi-manual' },
    { manualIndex: 1, reason: 'multi-manual' },
  ]);
});

Deno.test('the largest detection inside a tag wins over a face in the background', () => {
  // Someone standing behind the tagged person: inside the box, but smaller.
  const manual: Box[] = [{ x: 0, y: 0, width: 200, height: 200 }];
  const auto: Box[] = [
    { x: 150, y: 20, width: 30, height: 30 },
    { x: 40, y: 40, width: 100, height: 100 },
    { x: 20, y: 150, width: 20, height: 20 },
  ];

  const { matches, ambiguous } = match(manual, auto);
  assertEquals(ambiguous, []);
  assertEquals(matches.map((m) => [m.manualIndex, m.autoIndex]), [[0, 1]]);
});

Deno.test('two equally large detections inside one tag leave it alone', () => {
  // Nothing says who is in front, so this is the one multi-detection case
  // still left for a human.
  const manual: Box[] = [{ x: 0, y: 0, width: 200, height: 100 }];
  const auto: Box[] = [
    { x: 10, y: 10, width: 60, height: 60 },
    { x: 120, y: 10, width: 60, height: 60 },
  ];

  const { matches, ambiguous } = match(manual, auto);
  assertEquals(matches, []);
  assertEquals(ambiguous, [{ manualIndex: 0, reason: 'multi-auto' }]);
});

Deno.test('a large detection crossing the edge does not outrank the one inside', () => {
  // The neighbour's face is bigger and overlaps more, but a corner sticks out,
  // so it is not even a candidate.
  const manual: Box[] = [{ x: 0, y: 0, width: 100, height: 100 }];
  const auto: Box[] = [
    { x: 40, y: 20, width: 80, height: 80 },
    { x: 20, y: 30, width: 30, height: 30 },
  ];

  const { matches, ambiguous } = match(manual, auto);
  assertEquals(ambiguous, []);
  assertEquals(matches.map((m) => [m.manualIndex, m.autoIndex]), [[0, 1]]);
});

Deno.test('a detection outside the tag does not make it ambiguous', () => {
  const manual: Box[] = [{ x: 0, y: 0, width: 50, height: 50 }];
  const auto: Box[] = [
    { x: 2, y: 2, width: 46, height: 46 },
    { x: 300, y: 300, width: 46, height: 46 },
  ];
  const { matches, ambiguous } = match(manual, auto);
  assertEquals(ambiguous, []);
  assertEquals(matches.length, 1);
  assertEquals(matches[0].autoIndex, 0);
});

Deno.test('empty input yields no matches', () => {
  assertEquals(match([], [{ x: 0, y: 0, width: 10, height: 10 }]), { matches: [], ambiguous: [] });
  assertEquals(match([{ x: 0, y: 0, width: 10, height: 10 }], []), {
    matches: [],
    ambiguous: [{ manualIndex: 0, reason: 'none' }],
  });
});

Deno.test('minScale leaves a tag whose only face inside is a background one', () => {
  // A box drawn round the back of someone's head, with a stranger's face far behind them.
  const manual: Box[] = [{ x: 0, y: 0, width: 200, height: 200 }];
  const auto: Box[] = [{ x: 150, y: 20, width: 20, height: 20 }];

  assertEquals(matchFacesUnique(manual, auto, { margin: 0 }).matches.length, 1, 'without it the stranger gets the name');
  const { matches, ambiguous } = matchFacesUnique(manual, auto, { margin: 0, minScale: DEFAULT_MIN_SCALE });
  assertEquals(matches, []);
  assertEquals(ambiguous, [{ manualIndex: 0, reason: 'too-small' }]);
});

Deno.test('minScale judges the largest face inside, not the smallest', () => {
  // The person the box was drawn round is in front; the small face behind does not veto them.
  const manual: Box[] = [{ x: 0, y: 0, width: 200, height: 200 }];
  const auto: Box[] = [
    { x: 40, y: 40, width: 90, height: 90 },
    { x: 150, y: 20, width: 20, height: 20 },
  ];
  const { matches, ambiguous } = matchFacesUnique(manual, auto, { margin: 0, minScale: DEFAULT_MIN_SCALE });
  assertEquals(ambiguous, []);
  assertEquals(matches.map((m) => m.autoIndex), [0]);
});
