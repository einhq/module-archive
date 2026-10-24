/**
 * Cutting the dendrogram `subcluster-faces` returns.
 *
 * The server builds the agglomeration once — that is the quadratic part, and it
 * is not repeated here. Cutting it is a union-find over a prefix of the merge
 * list, which is cheap enough to redo on every frame of a slider drag. That is
 * the whole reason the command returns a dendrogram instead of groups: a
 * reviewer tries a dozen thresholds before committing to one, and none of them
 * should cost a round trip.
 *
 * The mirror of the cut half of `@archive/media/face-subcluster`, deliberately
 * duplicated rather than imported so the page does not pull in server code.
 * Kept small on purpose, and free of the shell client so it is testable without
 * a browser runtime.
 */

import type { Merge } from '@archive/media/api';
export type { Merge } from '@archive/media/api';

/** Apply the first `count` merges and return a group label per face. */
function applyMerges(n: number, merges: Merge[], count: number): number[] {
  const parent = new Int32Array(n + merges.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };

  for (let i = 0; i < count; i++) {
    const [a, b] = merges[i];
    parent[find(a)] = find(b);
    parent[find(n + i)] = find(b);
  }

  // Dense labels in first-appearance order, so they are usable as array indices.
  const dense = new Map<number, number>();
  const labels: number[] = [];
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let label = dense.get(root);
    if (label === undefined) {
      label = dense.size;
      dense.set(root, label);
    }
    labels.push(label);
  }
  return labels;
}

/** Keep only merges at or above `minSim`. Merges are sorted, so this is a prefix. */
export function cutAtSimilarity(n: number, merges: Merge[], minSim: number): number[] {
  let count = 0;
  while (count < merges.length && merges[count][2] >= minSim) count++;
  return applyMerges(n, merges, count);
}

/** Cut into at most `k` groups — the last `k - 1` merges undone. */
export function cutIntoK(n: number, merges: Merge[], k: number): number[] {
  const wanted = Math.max(1, Math.min(k, n));
  return applyMerges(n, merges, Math.max(0, n - wanted));
}

/** Face indices per label, largest group first, ties on the lowest member. */
export function groupsFrom(labels: number[]): number[][] {
  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const group = byLabel.get(labels[i]);
    if (group) group.push(i);
    else byLabel.set(labels[i], [i]);
  }
  return [...byLabel.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
}

/**
 * Groups worth putting on a slider.
 *
 * Not every bad person splits in two. A cluster chained together from ears,
 * hands and things that are not faces at all has no gap, and only comes apart
 * past a hundred groups, so a tighter cap would put its working range off the
 * end of the control.
 */
const MAX_USEFUL_GROUPS = 200;

/**
 * The similarity range worth showing on a slider.
 *
 * A fixed 0..1 range is nearly all dead travel. Real average-link merges bunch
 * low — on a fused person the two people join far below the merges that build
 * each of them, while the top of the range is a long tail of near-identical
 * crops. So the slider spans from just under the final join to wherever the cut
 * would produce `MAX_USEFUL_GROUPS` groups, and every position in between
 * changes the answer.
 */
export function cutRange(merges: Merge[]): { min: number; max: number } {
  if (merges.length === 0) return { min: 0, max: 1 };

  // Merges arrive by decreasing similarity, so the last one is the final join.
  const lo = merges[merges.length - 1][2];
  // Keeping merges 0..i leaves n-(i+1) groups; this is the i for MAX_USEFUL_GROUPS of them.
  const hi = merges[Math.max(0, merges.length - MAX_USEFUL_GROUPS)][2];

  // A degenerate span (every merge at the same similarity) still needs width.
  if (hi - lo < 0.02) return { min: Math.max(0, lo - 0.05), max: Math.min(1, lo + 0.05) };
  return { min: Math.max(0, lo - 0.005), max: Math.min(1, hi) };
}
