/**
 * Pure-unit tests for face label propagation. Fast tier: no VFS, no models.
 */

import { assertEquals } from '@std/assert';
import { type FaceEdge, mutualEdges, propagateLabels } from '../../lib/media/face-cluster.ts';

const opts = { threshold: 0.5, minMargin: 1.2, minVotes: 0.5 };

Deno.test('recognizes an untagged face from agreeing tagged neighbours', () => {
  const labeled = new Map([['f1', 'anna'], ['f2', 'anna']]);
  const edges: FaceEdge[] = [
    { a: 'f1', b: 'x', sim: 0.8 },
    { a: 'f2', b: 'x', sim: 0.7 },
  ];
  const { assignments } = propagateLabels(edges, labeled, opts);
  assertEquals(assignments.length, 1);
  assertEquals(assignments[0].faceId, 'x');
  assertEquals(assignments[0].personId, 'anna');
  assertEquals(assignments[0].votes, 2);
});

Deno.test('does not assign when tagged neighbours are split without a margin', () => {
  const labeled = new Map([['f1', 'anna'], ['f2', 'bob']]);
  const edges: FaceEdge[] = [
    { a: 'f1', b: 'x', sim: 0.7 },
    { a: 'f2', b: 'x', sim: 0.7 }, // tie -> no clear winner
  ];
  const { assignments } = propagateLabels(edges, labeled, opts);
  assertEquals(assignments.length, 0);
});

Deno.test('assigns when one person clears the runner-up by the margin', () => {
  const labeled = new Map([['f1', 'anna'], ['f2', 'anna'], ['f3', 'bob']]);
  const edges: FaceEdge[] = [
    { a: 'f1', b: 'x', sim: 0.8 },
    { a: 'f2', b: 'x', sim: 0.8 }, // anna weight 1.6
    { a: 'f3', b: 'x', sim: 0.6 }, // bob weight 0.6
  ];
  const { assignments } = propagateLabels(edges, labeled, opts);
  assertEquals(assignments.length, 1);
  assertEquals(assignments[0].personId, 'anna');
});

Deno.test('ignores votes below the similarity threshold', () => {
  const labeled = new Map([['f1', 'anna']]);
  const edges: FaceEdge[] = [{ a: 'f1', b: 'x', sim: 0.4 }]; // < 0.5
  const { assignments } = propagateLabels(edges, labeled, opts);
  assertEquals(assignments.length, 0);
});

Deno.test('groups untagged faces with no tagged neighbour into a cluster', () => {
  const labeled = new Map<string, string>();
  const edges: FaceEdge[] = [
    { a: 'u1', b: 'u2', sim: 0.9 },
    { a: 'u2', b: 'u3', sim: 0.8 },
    { a: 'u5', b: 'u6', sim: 0.7 },
  ];
  const { assignments, clusters } = propagateLabels(edges, labeled, opts);
  assertEquals(assignments.length, 0);
  assertEquals(clusters.length, 2);
  assertEquals(clusters[0].members, ['u1', 'u2', 'u3']); // largest first
  assertEquals(clusters[1].members, ['u5', 'u6']);
});

Deno.test('clusterThreshold splits a component that the vote threshold would fuse', () => {
  const labeled = new Map<string, string>();
  // u2-u3 is the weak link: strong enough to vote on, too weak to group on.
  const edges: FaceEdge[] = [
    { a: 'u1', b: 'u2', sim: 0.9 },
    { a: 'u2', b: 'u3', sim: 0.55 },
    { a: 'u3', b: 'u4', sim: 0.9 },
  ];

  const fused = propagateLabels(edges, labeled, opts);
  assertEquals(fused.clusters.length, 1);
  assertEquals(fused.clusters[0].members, ['u1', 'u2', 'u3', 'u4']);

  const split = propagateLabels(edges, labeled, { ...opts, clusterThreshold: 0.6 });
  assertEquals(split.clusters.length, 2);
  assertEquals(split.clusters.map((c) => c.members), [['u1', 'u2'], ['u3', 'u4']]);
});

Deno.test('clusterThreshold does not weaken voting', () => {
  const labeled = new Map([['f1', 'anna']]);
  // The vote sits below the stricter grouping bar but above the vote bar.
  const edges: FaceEdge[] = [{ a: 'f1', b: 'x', sim: 0.55 }];
  const { assignments } = propagateLabels(edges, labeled, { ...opts, clusterThreshold: 0.9 });
  assertEquals(assignments.map((a) => a.personId), ['anna']);
});

Deno.test('mutualEdges drops one-way neighbours and dedupes the rest', () => {
  const edges: FaceEdge[] = [
    { a: 'u1', b: 'u2', sim: 0.9 },
    { a: 'u2', b: 'u1', sim: 0.9 }, // mutual with the above
    { a: 'hub', b: 'u3', sim: 0.7 }, // one-way: u3 never lists hub
  ];
  const kept = mutualEdges(edges);
  assertEquals(kept.length, 1);
  assertEquals([kept[0].a, kept[0].b].sort(), ['u1', 'u2']);
});

Deno.test('mutualEdges keeps a hub from chaining two people together', () => {
  const labeled = new Map<string, string>();
  // a1/a2 are one person, b1/b2 another; `hub` lists both but neither lists it.
  const edges: FaceEdge[] = [
    { a: 'a1', b: 'a2', sim: 0.9 },
    { a: 'a2', b: 'a1', sim: 0.9 },
    { a: 'b1', b: 'b2', sim: 0.9 },
    { a: 'b2', b: 'b1', sim: 0.9 },
    { a: 'hub', b: 'a1', sim: 0.7 },
    { a: 'hub', b: 'b1', sim: 0.7 },
  ];

  assertEquals(propagateLabels(edges, labeled, opts).clusters.length, 1, 'the hub fuses both people');

  const clusters = propagateLabels(mutualEdges(edges), labeled, opts).clusters;
  assertEquals(clusters.length, 2);
  assertEquals(clusters.map((c) => c.members), [['a1', 'a2'], ['b1', 'b2']]);
});

Deno.test('a recognized face is not also put in a cluster', () => {
  const labeled = new Map([['f1', 'anna'], ['f2', 'anna']]);
  const edges: FaceEdge[] = [
    { a: 'f1', b: 'x', sim: 0.8 },
    { a: 'f2', b: 'x', sim: 0.8 },
    { a: 'x', b: 'y', sim: 0.8 }, // x also near untagged y
    { a: 'y', b: 'z', sim: 0.8 },
  ];
  const { assignments, clusters } = propagateLabels(edges, labeled, opts);
  assertEquals(assignments.map((a) => a.faceId), ['x']);
  // y,z form a cluster; x excluded because it was recognized
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].members.includes('x'), false);
});

Deno.test('a person rejected for a face gets no vote on it', () => {
  const labeled = new Map([['f1', 'anna'], ['f2', 'anna'], ['f3', 'bob']]);
  const edges: FaceEdge[] = [
    { a: 'f1', b: 'x', sim: 0.9 },
    { a: 'f2', b: 'x', sim: 0.9 },
    { a: 'f3', b: 'x', sim: 0.6 },
  ];
  // Without the rejection anna wins; with it, bob is all that is left.
  assertEquals(propagateLabels(edges, labeled, opts).assignments[0].personId, 'anna');
  const rejected = new Map([['x', new Set(['anna'])]]);
  const { assignments } = propagateLabels(edges, labeled, { ...opts, rejected });
  assertEquals(assignments.map((a) => [a.faceId, a.personId]), [['x', 'bob']]);
});
