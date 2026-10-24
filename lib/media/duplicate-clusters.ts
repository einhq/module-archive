/**
 * Near-duplicate clusters for `duplicates --fuzzy`, by complete linkage over file paths: two
 * clusters join only when every file of one is a copy of every file of the other, so a chain of
 * retakes, each close to the next, stays apart. Edges are taken best first, and a cluster's score
 * is the best edge inside it.
 */

/** Two files whose fingerprints are close enough to call them copies, and how close. */
export type Edge = { a: string; b: string; sim: number };

/** Whether two files that no edge joins are copies: their similarity if so, else null. */
type PairScore = (a: string, b: string) => number | null;

type DuplicateCluster = { members: string[]; topSimilarity: number };

const pairKey = (a: string, b: string): string => a < b ? `${a}\0${b}` : `${b}\0${a}`;

/**
 * The files the edges connect into groups of three or more: the only ones whose clusters ask
 * `score` about a pair, since a group of two is its one edge.
 */
export function chainedFiles(edges: Edge[]): string[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = x; node !== root;) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const { a, b } of edges) if (a !== b) parent.set(find(a), find(b));
  const size = new Map<string, number>();
  for (const node of parent.keys()) size.set(find(node), (size.get(find(node)) ?? 0) + 1);
  return [...parent.keys()].filter((node) => size.get(find(node))! >= 3).sort();
}

/**
 * Every cluster of two or more, members sorted. An edge between two clusters joins them when each
 * other pair across them is an edge too, or `score` calls it a copy.
 */
export function duplicateClusters(edges: Edge[], score: PairScore): DuplicateCluster[] {
  const known = new Map<string, number>();
  for (const { a, b, sim } of edges) {
    if (a === b) continue;
    const key = pairKey(a, b);
    known.set(key, Math.max(sim, known.get(key) ?? sim));
  }
  const scored = new Map<string, number | null>();
  const linked = (a: string, b: string): boolean => {
    const key = pairKey(a, b);
    if (known.has(key)) return true;
    if (!scored.has(key)) scored.set(key, score(a, b));
    return scored.get(key) !== null;
  };

  const clusterOf = new Map<string, DuplicateCluster>();
  const single = (file: string): DuplicateCluster => {
    const cluster = { members: [file], topSimilarity: 0 };
    clusterOf.set(file, cluster);
    return cluster;
  };
  const ordered = [...known].map(([key, sim]) => ({ key, sim })).sort((x, y) => y.sim - x.sim || (x.key < y.key ? -1 : 1));
  for (const { key, sim } of ordered) {
    const [a, b] = key.split('\0');
    const [ca, cb] = [clusterOf.get(a) ?? single(a), clusterOf.get(b) ?? single(b)];
    if (ca === cb || !ca.members.every((x) => cb.members.every((y) => linked(x, y)))) continue;
    const [into, from] = ca.members.length >= cb.members.length ? [ca, cb] : [cb, ca];
    into.members.push(...from.members);
    into.topSimilarity = Math.max(into.topSimilarity, from.topSimilarity, sim);
    for (const member of from.members) clusterOf.set(member, into);
  }
  return [...new Set(clusterOf.values())]
    .filter((cluster) => cluster.members.length >= 2)
    .map((cluster) => ({ members: cluster.members.sort(), topSimilarity: cluster.topSimilarity }));
}
