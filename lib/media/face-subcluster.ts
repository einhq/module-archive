/**
 * Sub-clustering *inside* one person — pure logic, no VFS/IO, so it is
 * unit-testable in the fast tier.
 *
 * `face-cluster.ts` builds people out of single-link connected components over
 * near-neighbour edges, and says what that costs: one weak edge fuses two people
 * and no later evidence pulls them apart. This is the repair. Once a set of
 * faces is already believed to be one person it is small — thousands, not
 * millions — so the honest thing becomes affordable: **average linkage** over
 * every pairwise similarity, which is the whole point. Re-running single-link at a
 * stricter threshold would shatter a person into fragments long before it
 * separated the two people inside them, because single-link is exactly what
 * fused them.
 *
 * The result is a dendrogram rather than a set of groups. Cutting it is
 * trivially cheap, so a caller can offer a threshold slider and re-cut with no
 * further work, and "split in two" is just the last merge undone.
 */

/** One agglomeration step. `a` and `b` are cluster ids; see `Dendrogram`. */
type Merge = {
  a: number;
  b: number;
  /** Average cosine similarity between the two merged clusters. */
  sim: number;
  /** Number of items in the merged cluster. */
  size: number;
};

/**
 * A full agglomeration of `n` items in exactly `n - 1` merges, ordered by
 * decreasing similarity.
 *
 * Cluster ids follow the scipy convention: `0..n-1` are the original items and
 * merge `i` creates cluster `n + i`. That numbering is what makes a cut a
 * union-find over a prefix of the list.
 */
type Dendrogram = { n: number; merges: Merge[] };

/**
 * L2-normalise a vector so cosine similarity is a plain dot product.
 * A zero vector stays zero, and then scores 0 against everything.
 */
export const normalize = (values: ArrayLike<number>): Float32Array => {
  const out = new Float32Array(values.length);
  let norm = 0;
  for (let i = 0; i < values.length; i++) norm += values[i] * values[i];
  if (norm === 0) return out;
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < values.length; i++) out[i] = values[i] * scale;
  return out;
};

/** Index into a condensed upper-triangle matrix, for i < j. */
const condensedIndex = (n: number, i: number, j: number): number => (n * i) - ((i * (i + 1)) / 2) + j - i - 1;

/**
 * Four independent sums rather than one: this is where every build spends its
 * time, and V8 runs the unrolled loop about a quarter faster.
 */
const dot = (a: Float32Array, b: Float32Array): number => {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const end = a.length - (a.length % 4);
  let d = 0;
  for (; d < end; d += 4) {
    s0 += a[d] * b[d];
    s1 += a[d + 1] * b[d + 1];
    s2 += a[d + 2] * b[d + 2];
    s3 += a[d + 3] * b[d + 3];
  }
  for (; d < a.length; d++) s0 += a[d] * b[d];
  return s0 + s1 + s2 + s3;
};

/**
 * Every pairwise average-link cosine *distance*, upper triangle only, between
 * items that are each a set of unit vectors given by its sum and its size.
 *
 * The mean of every pairwise dot product between two sets is the dot product
 * of their sums over the product of their sizes, so a set of faces costs no more
 * to compare than one face. A single face is its own vector with size 1.
 *
 * n(n-1)/2 floats: 901 items is 405k entries (1.6 MB), 3000 is 4.5M (18 MB).
 * The full square would double that for no gain — the matrix is symmetric and
 * the diagonal is never read.
 */
const distanceMatrix = (sums: Float32Array[], sizes: Int32Array): Float32Array => {
  const n = sums.length;
  const dist = new Float32Array((n * (n - 1)) / 2);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) dist[condensedIndex(n, i, j)] = 1 - (dot(sums[i], sums[j]) / (sizes[i] * sizes[j]));
  }

  return dist;
};

/**
 * Average-link (UPGMA) agglomerative clustering by nearest-neighbour chain.
 *
 * NN-chain is O(n²) and deterministic. The obvious alternative — keep each
 * cluster's nearest neighbour and recompute the ones invalidated by a merge —
 * is O(n³) in the worst case, which at n = 1279 is two billion operations. The
 * algorithm is valid here because average linkage is reducible: merging two
 * mutual nearest neighbours can never bring a third cluster closer than either
 * of them already was.
 *
 * Distances are updated in place with the Lance-Williams rule for UPGMA,
 * `d(A∪B, C) = (|A|·d(A,C) + |B|·d(B,C)) / (|A|+|B|)`, keeping the merged
 * cluster in the slot of the lower of the two rows. Each merge's `size` counts
 * original faces, so items that start as sets of faces weigh what they hold.
 */
const linkage = (sums: Float32Array[], sizes: Int32Array): Dendrogram => {
  const n = sums.length;
  if (n < 2) return { n, merges: [] };

  const dist = distanceMatrix(sums, sizes);
  const d = (i: number, j: number): number => dist[i < j ? condensedIndex(n, i, j) : condensedIndex(n, j, i)];
  const setD = (i: number, j: number, value: number): void => {
    dist[i < j ? condensedIndex(n, i, j) : condensedIndex(n, j, i)] = value;
  };

  /** Slot -> live or absorbed. An absorbed slot is skipped by every scan. */
  const alive = new Uint8Array(n).fill(1);
  /** Slot -> number of original faces in the cluster occupying it. */
  const size = Int32Array.from(sizes);
  /** Slot -> dendrogram cluster id (0..n-1 initially, n+i after merge i). */
  const label = new Int32Array(n);
  for (let i = 0; i < n; i++) label[i] = i;

  /** Closest live slot to `from`. Ties break on the lower slot, so runs are reproducible. */
  const nearest = (from: number): { slot: number; dist: number } => {
    let slot = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i] || i === from) continue;
      const candidate = d(from, i);
      if (candidate < best) {
        best = candidate;
        slot = i;
      }
    }
    return { slot, dist: best };
  };

  const chain: number[] = [];
  const merges: Merge[] = [];

  while (merges.length < n - 1) {
    if (chain.length === 0) {
      for (let i = 0; i < n; i++) {
        if (alive[i]) {
          chain.push(i);
          break;
        }
      }
    }

    // Walk until the chain's head and its nearest neighbour are mutual.
    let a = chain[chain.length - 1];
    let found = nearest(a);
    while (!(chain.length > 1 && found.slot === chain[chain.length - 2])) {
      chain.push(found.slot);
      a = found.slot;
      found = nearest(a);
    }
    const b = found.slot;

    // Both ends of the mutual pair leave the chain. The merged cluster is *not*
    // pushed back: reducibility guarantees what remains is still a valid chain,
    // and that is what keeps the whole build O(n²).
    chain.pop();
    chain.pop();

    const keep = Math.min(a, b);
    const drop = Math.max(a, b);
    const merged = size[keep] + size[drop];

    for (let i = 0; i < n; i++) {
      if (!alive[i] || i === keep || i === drop) continue;
      setD(keep, i, ((size[keep] * d(keep, i)) + (size[drop] * d(drop, i))) / merged);
    }

    merges.push({ a: label[keep], b: label[drop], sim: 1 - found.dist, size: merged });
    label[keep] = n + merges.length - 1;
    size[keep] = merged;
    alive[drop] = 0;
  }

  // NN-chain finds mutual nearest pairs, not globally closest ones, so the
  // merges come out unordered. Sorting them and renumbering gives the standard
  // monotone linkage every cut function below assumes.
  return { n, merges: reorder(n, merges) };
};

/**
 * Faces the exact build takes directly. The matrix is n²/2 floats and its build
 * n²/2 dot products: 3000 faces is 18 MB and about two seconds, and 11000 would
 * be 240 MB and fifteen.
 */
const MAX_EXACT = 3000;

/** Cells a larger person is first divided into; see `partition`. */
const CELLS = 250;

/** A small seeded generator, so the same person always divides the same way. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Divide unit vectors into at most `k` cells of near neighbours: k-means++
 * seeding, each vector in the cell of the seed it is most similar to. One pass,
 * k·n dot products.
 *
 * Each next seed is drawn with weight `1 - similarity` to the nearest seed so
 * far, which is what the question needs: a handful of faces of somebody else,
 * far from everything, are likely to get a seed of their own instead of being
 * absorbed into a cell of the person they were fused with. A plain farthest-first
 * pick would do that too but spend every seed on outliers, leaving the bulk of
 * the person in a few huge cells.
 *
 * Cells come back as member index lists, empty ones dropped.
 */
const partition = (vectors: Float32Array[], k: number): number[][] => {
  const n = vectors.length;
  const random = mulberry32(0x5eed);
  const best = new Float32Array(n).fill(-Infinity);
  const owner = new Int32Array(n);

  let seed = 0;
  let seeds = 0;
  while (seeds < k) {
    const vector = vectors[seed];
    for (let i = 0; i < n; i++) {
      const sim = dot(vectors[i], vector);
      if (sim > best[i]) {
        best[i] = sim;
        owner[i] = seeds;
      }
    }
    seeds++;

    let total = 0;
    for (let i = 0; i < n; i++) total += Math.max(0, 1 - best[i]);
    // Every vector already sits on a seed: more cells would only be empty.
    if (total <= 1e-9) break;

    let target = random() * total;
    seed = n - 1;
    for (let i = 0; i < n; i++) {
      target -= Math.max(0, 1 - best[i]);
      if (target < 0) {
        seed = i;
        break;
      }
    }
  }

  const cells: number[][] = Array.from({ length: seeds }, () => []);
  for (let i = 0; i < n; i++) cells[owner[i]].push(i);
  return cells.filter((cell) => cell.length > 0);
};

/**
 * Average-link dendrogram over unit vectors, for any number of them.
 *
 * Up to `MAX_EXACT` it is the exact one. Past that the n² matrix is not
 * affordable, so the bottom of the tree is built locally: the faces are divided
 * into cells of near neighbours (`partition`), each cell gets its own exact
 * dendrogram, and of all those merges only the tightest are kept — just enough
 * to leave `MAX_EXACT` groups. Those groups are then joined by the exact build,
 * which scores two groups by the mean similarity over every pair of their faces,
 * from their sums. Everything below the tightest local merges — every level at
 * which two people could part — is therefore true average linkage; what is
 * approximate is only that a face's closest merges are with its own cell.
 *
 * A kept group can score higher against another than one of its own merges did.
 * Such a join is lowered to that merge's similarity, which keeps the merges
 * monotone and every cut a prefix, and only touches levels above the kept ones.
 */
export const buildDendrogram = (input: Float32Array[]): Dendrogram => {
  const n = input.length;
  if (n <= MAX_EXACT) return linkage(input, new Int32Array(n).fill(1));

  // A cell larger than the exact build takes is cut into pieces in index order.
  // Each piece is still a set of near neighbours, and the top level rejoins them.
  const cells = partition(input, CELLS).flatMap((cell) => {
    const pieces: number[][] = [];
    for (let i = 0; i < cell.length; i += MAX_EXACT) pieces.push(cell.slice(i, i + MAX_EXACT));
    return pieces;
  });
  const local = cells.map((cell) => linkage(cell.map((i) => input[i]), new Int32Array(cell.length).fill(1)));

  // Keep the tightest local merges, n - MAX_EXACT of them. Each cell's merges are
  // sorted, so what a cell keeps is a prefix of its list.
  const sims = local.flatMap((d) => d.merges.map((merge) => merge.sim)).sort((a, b) => b - a);
  const floor = sims[Math.min(n - MAX_EXACT, sims.length) - 1];

  // Every merge in one list, merge `i` creating cluster `n + i` as in the result.
  const merges: Merge[] = [];
  const simOf = (id: number) => (id < n ? Infinity : merges[id - n].sim);
  const add = (merge: Merge) => merges.push({ ...merge, sim: Math.min(merge.sim, simOf(merge.a), simOf(merge.b)) });

  // The kept merges form a forest; each tree is one group for the top level,
  // named by its root, carrying the sum of its faces.
  const roots: number[] = [];
  const sums: Float32Array[] = [];
  const sizes: number[] = [];
  for (const [index, cell] of cells.entries()) {
    const base = n + merges.length;
    const kept = local[index].merges.filter((merge) => merge.sim >= floor);
    const id = (x: number) => (x < cell.length ? cell[x] : base + x - cell.length);
    for (const merge of kept) add({ ...merge, a: id(merge.a), b: id(merge.b) });

    // Which tree each face of the cell ended up in, by its root's local id.
    const parent = new Int32Array(cell.length + kept.length).map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [i, merge] of kept.entries()) parent[find(merge.a)] = parent[find(merge.b)] = cell.length + i;

    const tree = new Map<number, number>();
    for (const [x, face] of cell.entries()) {
      const root = find(x);
      let at = tree.get(root);
      if (at === undefined) {
        at = roots.length;
        tree.set(root, at);
        roots.push(id(root));
        sums.push(new Float32Array(input[face].length));
        sizes.push(0);
      }
      const sum = sums[at];
      for (let d = 0; d < sum.length; d++) sum[d] += input[face][d];
      sizes[at]++;
    }
  }

  const base = n + merges.length;
  const top = linkage(sums, Int32Array.from(sizes));
  const id = (x: number) => (x < roots.length ? roots[x] : base + x - roots.length);
  for (const merge of top.merges) add({ ...merge, a: id(merge.a), b: id(merge.b) });

  return { n, merges: reorder(n, merges) };
};

/**
 * Sort merges by decreasing similarity and renumber the cluster ids they create
 * so merge `i` still yields cluster `n + i`.
 */
const reorder = (n: number, merges: Merge[]): Merge[] => {
  const order = merges.map((_, i) => i).sort((x, y) => merges[y].sim - merges[x].sim || x - y);
  // Old cluster id -> new cluster id. Items 0..n-1 keep their ids.
  const remap = new Map<number, number>();
  for (let position = 0; position < order.length; position++) remap.set(n + order[position], n + position);

  const id = (old: number) => (old < n ? old : remap.get(old)!);
  return order.map((source) => {
    const merge = merges[source];
    return { a: id(merge.a), b: id(merge.b), sim: merge.sim, size: merge.size };
  });
};

/** Apply the first `count` merges and return a label per original item. */
const applyMerges = (d: Dendrogram, count: number): number[] => {
  const parent = new Int32Array(d.n + d.merges.length);
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
    const merge = d.merges[i];
    parent[find(merge.a)] = find(merge.b);
    parent[find(d.n + i)] = find(merge.b);
  }

  // Renumber roots to dense labels in first-appearance order.
  const dense = new Map<number, number>();
  const labels: number[] = [];
  for (let i = 0; i < d.n; i++) {
    const root = find(i);
    let label = dense.get(root);
    if (label === undefined) {
      label = dense.size;
      dense.set(root, label);
    }
    labels.push(label);
  }
  return labels;
};

/**
 * Cut the dendrogram so that only merges at or above `minSim` are kept.
 * Merges are ordered by decreasing similarity, so this is a prefix.
 */
export const cutAtSimilarity = (d: Dendrogram, minSim: number): number[] => {
  let count = 0;
  while (count < d.merges.length && d.merges[count].sim >= minSim) count++;
  return applyMerges(d, count);
};

/** Cut the dendrogram into at most `k` groups — the last `k - 1` merges undone. */
export const cutIntoK = (d: Dendrogram, k: number): number[] => {
  const wanted = Math.max(1, Math.min(k, d.n));
  return applyMerges(d, Math.max(0, d.n - wanted));
};

/**
 * Where to cut, from the shape of the dendrogram rather than a fixed number.
 *
 * A fixed threshold cannot work here. Average linkage scores much lower than the
 * single-link bar `cluster-faces` uses, because it averages over every pair
 * including the bad ones — on a fused person the top merges can sit around
 * 0.33 and the join of the two people themselves near 0, so a single-link bar
 * would return a hundred fragments and say nothing.
 *
 * What is legible instead is the *gap*. Two people fused into one leave a large
 * drop between the merge that finishes each of them and the merge that joins the
 * two, and cutting in it separates them. Someone who really is one person has no
 * such drop, so a gap below `minGap` suggests no split at all.
 *
 * Only the top `maxGroups` merges are considered: below that the question is no
 * longer "is this two people".
 */
export const suggestCut = (d: Dendrogram, maxGroups = 12, minGap = 0.05): { threshold: number; groups: number } => {
  const merges = d.merges;
  if (merges.length === 0) return { threshold: 0, groups: d.n };

  // Keeping merges 0..i leaves n-(i+1) groups, so i counts down from the top.
  let bestGap = 0;
  let bestIndex = -1;
  for (let i = merges.length - 2; i >= Math.max(0, merges.length - maxGroups); i--) {
    const gap = merges[i].sim - merges[i + 1].sim;
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }

  // No drop worth acting on: one person, and the reviewer can still overrule.
  if (bestIndex < 0 || bestGap < minGap) return { threshold: merges[merges.length - 1].sim, groups: 1 };

  return {
    // Inside the gap, so the cut is not sitting on a merge's exact value.
    threshold: (merges[bestIndex].sim + merges[bestIndex + 1].sim) / 2,
    groups: d.n - bestIndex - 1,
  };
};

/** Item indices per label, largest group first, ties on the lowest member. */
export const groupsFrom = (labels: number[]): number[][] => {
  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const group = byLabel.get(labels[i]);
    if (group) group.push(i);
    else byLabel.set(labels[i], [i]);
  }
  return [...byLabel.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
};
