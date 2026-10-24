import { assertEquals } from '@std/assert';
import { cutAtSimilarity, cutIntoK, cutRange, groupsFrom, type Merge } from '../face-cut.ts';

/**
 * Five faces: 0,1,2 tight together and 3,4 tight together, the two halves
 * joined last and weakly — the shape of a person that is really two people.
 *
 *   [0,1] @0.95 -> 5      [3,4] @0.93 -> 6      [5,2] @0.90 -> 7      [7,6] @0.40 -> 8
 */
const N = 5;
const MERGES: Merge[] = [
  [0, 1, 0.95, 2],
  [3, 4, 0.93, 2],
  [5, 2, 0.90, 3],
  [7, 6, 0.40, 5],
];

const groups = (labels: number[]) => groupsFrom(labels).map((g) => [...g].sort((a, b) => a - b));

Deno.test('cutAtSimilarity splits where the weak merge is', () => {
  // Below the weak merge everything is one person.
  assertEquals(groups(cutAtSimilarity(N, MERGES, 0.1)), [[0, 1, 2, 3, 4]]);
  // Above it, the two halves stand apart — the split the reviewer is after.
  assertEquals(groups(cutAtSimilarity(N, MERGES, 0.5)), [[0, 1, 2], [3, 4]]);
  // Tighter still and the halves start shedding members.
  assertEquals(groups(cutAtSimilarity(N, MERGES, 0.92)), [[0, 1], [3, 4], [2]]);
  assertEquals(groups(cutAtSimilarity(N, MERGES, 0.99)), [[0], [1], [2], [3], [4]]);
});

Deno.test('cutIntoK is the same cut counted from the top', () => {
  assertEquals(groups(cutIntoK(N, MERGES, 1)), [[0, 1, 2, 3, 4]]);
  assertEquals(groups(cutIntoK(N, MERGES, 2)), [[0, 1, 2], [3, 4]]);
  assertEquals(groups(cutIntoK(N, MERGES, 3)), [[0, 1], [3, 4], [2]]);
  assertEquals(groups(cutIntoK(N, MERGES, 5)), [[0], [1], [2], [3], [4]]);
  // Out-of-range k is clamped, not an error: the slider can ask for anything.
  assertEquals(groups(cutIntoK(N, MERGES, 0)), [[0, 1, 2, 3, 4]]);
  assertEquals(groups(cutIntoK(N, MERGES, 99)).length, 5);
});

Deno.test('groupsFrom orders by size, then by first member', () => {
  assertEquals(groupsFrom([1, 0, 1, 2, 1]), [[0, 2, 4], [1], [3]]);
  assertEquals(groupsFrom([]), []);
});

Deno.test('a person with no merges is one group, or none', () => {
  assertEquals(groups(cutAtSimilarity(1, [], 0.5)), [[0]]);
  assertEquals(groups(cutIntoK(1, [], 4)), [[0]]);
  assertEquals(groups(cutAtSimilarity(0, [], 0.5)), []);
});

Deno.test('cutRange spans the merges, not the whole 0..1', () => {
  // Just under the final join (0.40) at the bottom; with only four merges the
  // group cap does not bite, so the top is the tightest merge.
  const range = cutRange(MERGES);
  assertEquals(range.min < 0.4 && range.min >= 0.39, true);
  assertEquals(range.max, 0.95);
  // The whole interesting band is inside the slider.
  assertEquals(range.min < 0.4 && range.max >= 0.95, true);

  // Every merge at the same similarity still needs a slider with width.
  const flat = cutRange([[0, 1, 0.8, 2], [2, 3, 0.8, 2]]);
  assertEquals(flat.max - flat.min > 0, true);

  // Nothing to cut: the full range, so the control still renders.
  assertEquals(cutRange([]), { min: 0, max: 1 });
});

Deno.test('cutRange stops before the slider is only shredding', () => {
  // 500 merges from 1.000 down to 0.002. The top of the range is the merge that
  // yields two hundred groups; above that the travel would be a long tail of
  // near-identical crops that no reviewer needs to reach.
  const many: Merge[] = Array.from({ length: 500 }, (_, i) => [i, i + 1, (500 - i) / 500, 2]);
  const range = cutRange(many);

  assertEquals(range.max, many[300][2]);
  assertEquals(range.min < many[499][2], true);
});
