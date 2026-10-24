/**
 * Face label propagation — pure logic, no VFS/IO, so it is unit-testable in the
 * fast tier. Given the near-neighbour edges among face embeddings (from
 * EmbeddingRegistry.findAllPairs) and the faces already tagged to a person
 * (personId), it decides which untagged faces to recognize as an existing
 * person and groups the leftover untagged faces into candidate clusters
 * (suggestions for new/unnamed people).
 *
 * Recognition is deliberately conservative — identity is sensitive: a face is
 * only assigned when its tagged neighbours agree clearly (a margin over the
 * runner-up) and are similar enough (threshold). Everything else stays untagged.
 */

export type FaceEdge = { a: string; b: string; sim: number };

type PropagateOptions = {
  /** Minimum cosine similarity (0..1) for a neighbour's vote to count. */
  threshold: number;
  /** Winning person's total vote weight must exceed the runner-up's by this factor. */
  minMargin: number;
  /** Minimum winning vote weight required to assign at all. */
  minVotes: number;
  /**
   * Minimum similarity for two *untagged* faces to land in the same cluster.
   * Defaults to `threshold`.
   *
   * Grouping deserves a stricter bar than voting: a vote is checked against a
   * known person and can be outvoted, whereas clusters are single-link
   * connected components, so one weak edge silently fuses two people and no
   * later evidence can pull them apart.
   */
  clusterThreshold?: number;
  /**
   * faceId -> people a human said this face is *not* (`rejectedPersonIds`, written by
   * `person-detach --rematch`). Their votes are dropped for that face, so a rejected face
   * can land on anyone else, or seed somebody new, but never back on the person it left.
   */
  rejected?: ReadonlyMap<string, ReadonlySet<string>>;
};

type FaceAssignment = {
  faceId: string;
  personId: string;
  /** Winning person's share of this face's total vote weight (0..1). */
  confidence: number;
  /** Number of tagged neighbours that voted for the winner. */
  votes: number;
};

type FaceClusterGroup = { members: string[]; size: number };

type PropagateResult = {
  assignments: FaceAssignment[];
  /** Connected components of still-untagged faces (candidate new people). */
  clusters: FaceClusterGroup[];
};

/** Minimal weighted union-find over string ids. */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (!this.parent.has(x)) this.parent.set(x, x);
    while (root !== this.parent.get(root)) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      (out.get(root) ?? out.set(root, []).get(root)!).push(node);
    }
    return out;
  }
}

/**
 * Keep only edges whose endpoints are in each other's neighbour list.
 *
 * `findAllPairs` returns each face's top-k, so a hub face — a blurry or
 * low-quality detection that is mediocre-but-plausible against everyone —
 * appears in many faces' lists while none of them make it into its own. Those
 * one-way edges are what chains distinct people into a single giant component.
 * Requiring mutual agreement drops them for the cost of one pass.
 */
export const mutualEdges = (edges: FaceEdge[]): FaceEdge[] => {
  const seen = new Set<string>();
  for (const e of edges) seen.add(`${e.a}\0${e.b}`);

  const out: FaceEdge[] = [];
  const emitted = new Set<string>();
  for (const e of edges) {
    if (!seen.has(`${e.b}\0${e.a}`)) continue;
    // Both directions survive; emit the pair once, keyed on a stable order.
    const key = e.a < e.b ? `${e.a}\0${e.b}` : `${e.b}\0${e.a}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(e);
  }
  return out;
};

/**
 * Propagate person labels across face-similarity edges.
 *
 * @param edges         near-neighbour edges (both directions may appear)
 * @param labeledPerson faceId -> personId for faces already tagged
 */
export const propagateLabels = (
  edges: FaceEdge[],
  labeledPerson: Map<string, string>,
  opts: PropagateOptions,
): PropagateResult => {
  const clusterThreshold = opts.clusterThreshold ?? opts.threshold;
  // faceId -> (personId -> summed similarity weight) for untagged faces
  const votes = new Map<string, Map<string, { weight: number; count: number }>>();
  const addVote = (faceId: string, personId: string, sim: number) => {
    if (opts.rejected?.get(faceId)?.has(personId)) return;
    const tally = votes.get(faceId) ?? new Map();
    votes.set(faceId, tally);
    const cur = tally.get(personId) ?? { weight: 0, count: 0 };
    cur.weight += sim;
    cur.count += 1;
    tally.set(personId, cur);
  };

  const uf = new UnionFind();
  for (const e of edges) {
    if (!(e.sim >= opts.threshold)) continue;
    const pa = labeledPerson.get(e.a);
    const pb = labeledPerson.get(e.b);
    if (pa && !pb) addVote(e.b, pa, e.sim);
    else if (pb && !pa) addVote(e.a, pb, e.sim);
    // both untagged -> may form a cluster, on the stricter grouping bar
    else if (!pa && !pb && e.sim >= clusterThreshold) uf.union(e.a, e.b);
  }

  const assignments: FaceAssignment[] = [];
  const assigned = new Set<string>();
  for (const [faceId, tally] of votes) {
    let top: { personId: string; weight: number; count: number } | undefined;
    let secondWeight = 0;
    let total = 0;
    for (const [personId, v] of tally) {
      total += v.weight;
      if (!top || v.weight > top.weight) {
        if (top) secondWeight = Math.max(secondWeight, top.weight);
        top = { personId, weight: v.weight, count: v.count };
      } else {
        secondWeight = Math.max(secondWeight, v.weight);
      }
    }
    if (!top) continue;
    if (top.weight < opts.minVotes) continue;
    if (secondWeight > 0 && top.weight < secondWeight * opts.minMargin) continue;
    assignments.push({ faceId, personId: top.personId, confidence: total > 0 ? top.weight / total : 1, votes: top.count });
    assigned.add(faceId);
  }

  // Cluster the untagged faces that were NOT recognized.
  const clusters: FaceClusterGroup[] = [];
  for (const members of uf.groups().values()) {
    const remaining = members.filter((m) => !assigned.has(m) && !labeledPerson.has(m));
    if (remaining.length >= 2) clusters.push({ members: remaining.sort(), size: remaining.length });
  }
  clusters.sort((a, b) => b.size - a.size);

  return { assignments, clusters };
};
