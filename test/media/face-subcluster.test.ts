/**
 * Average-link sub-clustering of one person's faces: the dendrogram, and the
 * two ways of cutting it.
 *
 * The load-bearing claim is the one in the module header — that average linkage
 * separates two blobs joined by a weak bridge, where single-link (what built the
 * bad person in the first place) would keep chaining across it.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { buildDendrogram, cutAtSimilarity, cutIntoK, groupsFrom, normalize, suggestCut } from '../../lib/media/face-subcluster.ts';

const DIM = 16;
const HALF = DIM / 2;

/** Two orthogonal directions, one per block of coordinates — cosine 0 apart. */
const dir = (group: number) => Array.from({ length: DIM }, (_, i) => (Math.floor(i / HALF) === group ? 1 : 0));

/** Nudge one in-block coordinate so members of a blob are near-identical but distinct. */
const near = (base: number[], seed: number) => base.map((v, i) => (v === 1 && i % HALF === seed % HALF ? v + 0.02 : v));

const blob = (group: number, count: number) => Array.from({ length: count }, (_, i) => normalize(near(dir(group), i)));

/** Members of each group, as sorted index lists, largest group first. */
const groups = (labels: number[]) => groupsFrom(labels).map((g) => [...g].sort((a, b) => a - b));

Deno.test('buildDendrogram separates two blobs joined by a weak bridge', () => {
  // 6 of blob A, 4 of blob B, plus one bridge face halfway between them — the
  // single weak edge that single-link clustering fuses two people on.
  const a = blob(0, 6);
  const b = blob(1, 4);
  const bridge = normalize(dir(0).map((v, i) => v + dir(1)[i]));
  const vectors = [...a, ...b, bridge];

  const d = buildDendrogram(vectors);

  assertEquals(d.n, 11);
  assertEquals(d.merges.length, 10);

  // Merges come out ordered by decreasing similarity, and every merge's size is
  // the sum of what it joined.
  for (let i = 1; i < d.merges.length; i++) {
    assertEquals(d.merges[i].sim <= d.merges[i - 1].sim + 1e-6, true, `merge ${i} is not monotone`);
  }
  assertEquals(d.merges[d.merges.length - 1].size, 11);

  // Cut into two: the blobs come apart. The bridge lands on one side — which
  // one is not the point, that it does not glue them together is.
  const two = groups(cutIntoK(d, 2));
  assertEquals(two.length, 2);
  const blobA = [0, 1, 2, 3, 4, 5];
  const blobB = [6, 7, 8, 9];
  const withoutBridge = two.map((g) => g.filter((i) => i !== 10));
  assertEquals(withoutBridge.some((g) => g.join() === blobA.join()), true);
  assertEquals(withoutBridge.some((g) => g.join() === blobB.join()), true);
});

Deno.test('cutAtSimilarity trades group count for tightness', () => {
  const d = buildDendrogram([...blob(0, 5), ...blob(1, 5)]);

  // Below the between-blob similarity (0 — the blobs are orthogonal) everything
  // is one group; above it the two blobs stand apart; above their internal
  // similarity every face is its own group.
  assertEquals(groups(cutAtSimilarity(d, -1)).length, 1);
  assertEquals(groups(cutAtSimilarity(d, 0.5)).map((g) => g.length), [5, 5]);
  assertEquals(groups(cutAtSimilarity(d, 0.9999999)).length, 10);
});

Deno.test('cutIntoK is the same cut, counted from the top', () => {
  const d = buildDendrogram([...blob(0, 4), ...blob(1, 3), ...blob(0, 0)]);

  assertEquals(groups(cutIntoK(d, 1)).length, 1);
  assertEquals(groups(cutIntoK(d, 2)).map((g) => g.length), [4, 3]);
  assertEquals(groups(cutIntoK(d, 7)).length, 7);
  // More groups than items is not an error, it is just every item alone.
  assertEquals(groups(cutIntoK(d, 99)).length, 7);
  // Fewer than one is not a thing either.
  assertEquals(groups(cutIntoK(d, 0)).length, 1);
});

Deno.test('degenerate inputs do not produce merges', () => {
  assertEquals(buildDendrogram([]), { n: 0, merges: [] });
  assertEquals(buildDendrogram([normalize([1, 0])]), { n: 1, merges: [] });

  // One item is one group; no items is no groups.
  assertEquals(groupsFrom(cutIntoK({ n: 1, merges: [] }, 2)), [[0]]);
  assertEquals(groupsFrom(cutIntoK({ n: 0, merges: [] }, 2)), []);
});

Deno.test('normalize makes cosine a dot product, and leaves a zero vector alone', () => {
  const v = normalize([3, 4]);
  assertAlmostEquals(v[0], 0.6, 1e-6);
  assertAlmostEquals(v[1], 0.8, 1e-6);
  assertAlmostEquals((v[0] * v[0]) + (v[1] * v[1]), 1, 1e-6);

  assertEquals([...normalize([0, 0, 0])], [0, 0, 0]);
});

Deno.test('identical vectors merge at similarity 1', () => {
  const d = buildDendrogram(blob(0, 3).map(() => normalize(dir(0))));

  assertEquals(d.merges.length, 2);
  for (const merge of d.merges) assertAlmostEquals(merge.sim, 1, 1e-5);
  assertEquals(groups(cutAtSimilarity(d, 0.99)).length, 1);
});

Deno.test('suggestCut finds the gap two fused people leave', () => {
  // Two people fused into one: two tight groups whose own merges sit high and
  // whose join to each other sits far below.
  const d = buildDendrogram([...blob(0, 6), ...blob(1, 5)]);

  const cut = suggestCut(d);
  assertEquals(cut.groups, 2);
  assertEquals(groups(cutAtSimilarity(d, cut.threshold)).map((g) => g.length), [6, 5]);

  // The suggestion sits inside the gap, not on either merge.
  const top = d.merges[d.merges.length - 1].sim;
  const next = d.merges[d.merges.length - 2].sim;
  assertEquals(cut.threshold > top && cut.threshold < next, true);
});

Deno.test('suggestCut proposes no split when there is no gap', () => {
  // One person: the merges run smoothly down with nothing to cut at, so the
  // suggestion has to be "leave this alone" rather than an invented boundary.
  const d = buildDendrogram(blob(0, 8));

  const cut = suggestCut(d);
  assertEquals(cut.groups, 1);
  assertEquals(groups(cutAtSimilarity(d, cut.threshold)).length, 1);
});

Deno.test('suggestCut handles a person with nothing to cut', () => {
  assertEquals(suggestCut({ n: 1, merges: [] }), { threshold: 0, groups: 1 });
  assertEquals(suggestCut({ n: 0, merges: [] }), { threshold: 0, groups: 0 });
});

Deno.test('a hundred faces in four blobs cut cleanly', () => {
  // Bigger than the toy cases, so the NN-chain walk actually gets exercised:
  // four blobs, each in its own coordinate block, 25 faces apiece.
  const dim = 32;
  const block = dim / 4;
  const at = (group: number, seed: number) =>
    normalize(
      Array.from({ length: dim }, (_, i) => {
        if (Math.floor(i / block) !== group) return 0;
        return i % block === seed % block ? 1.02 : 1;
      }),
    );

  const vectors = [0, 1, 2, 3].flatMap((g) => Array.from({ length: 25 }, (_, i) => at(g, i)));
  const d = buildDendrogram(vectors);

  assertEquals(d.merges.length, 99);
  const four = groups(cutIntoK(d, 4));
  assertEquals(four.map((g) => g.length), [25, 25, 25, 25]);
  for (const group of four) {
    const expected = Math.floor(group[0] / 25);
    assertEquals(group.every((i) => Math.floor(i / 25) === expected), true, 'a group mixes two blobs');
  }
});

Deno.test('a person too large for the exact build still comes apart where the people part', () => {
  // Past 3000 faces the bottom of the tree is built cell by cell. Four blobs of
  // very different sizes, each jittered so its cells have structure of their own.
  const dim = 32;
  const block = dim / 4;
  let state = 1;
  const jitter = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state / 2147483648) * 0.3;
  };
  const at = (group: number) => normalize(Array.from({ length: dim }, (_, i) => (Math.floor(i / block) === group ? 1 + jitter() : 0)));

  const sizes = [2000, 900, 250, 50];
  const vectors = sizes.flatMap((count, g) => Array.from({ length: count }, () => at(g)));
  const blobOf = (i: number) => sizes.findIndex((_, g) => i < sizes.slice(0, g + 1).reduce((a, b) => a + b, 0));
  const d = buildDendrogram(vectors);

  // A complete, well-formed tree: n - 1 merges, monotone, each joining two
  // clusters that already exist and that nothing has joined before.
  assertEquals(d.merges.length, vectors.length - 1);
  assertEquals(d.merges[d.merges.length - 1].size, vectors.length);
  const used = new Set<number>();
  for (const [i, merge] of d.merges.entries()) {
    if (i > 0) assertEquals(merge.sim <= d.merges[i - 1].sim, true, `merge ${i} is not monotone`);
    for (const child of [merge.a, merge.b]) {
      assertEquals(child < vectors.length + i, true, `merge ${i} joins a cluster made later`);
      assertEquals(used.has(child), false, `cluster ${child} is joined twice`);
      used.add(child);
    }
  }

  const cut = suggestCut(d);
  assertEquals(cut.groups, 4);
  const four = groups(cutAtSimilarity(d, cut.threshold));
  assertEquals(four.map((g) => g.length), sizes);
  for (const group of four) assertEquals(group.every((i) => blobOf(i) === blobOf(group[0])), true, 'a group mixes two blobs');
});
