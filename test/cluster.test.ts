import { assertEquals } from '@std/assert';
import { clusterPoints } from '../lib/cluster.ts';

const point = (id: string, lat: number, lng: number) => ({ id, lat, lng });

Deno.test('clusterPoints buckets by cell and reports the centroid', () => {
  const clusters = clusterPoints([
    point('a', 10.1, 20.1),
    point('b', 10.3, 20.3),
    point('c', 12.5, 20.1),
  ], 1);

  assertEquals(clusters.length, 2);
  assertEquals(clusters[0].count, 2);
  assertEquals(clusters[0].memberIds, ['a', 'b']);
  assertEquals(clusters[0].lat, 10.2);
  assertEquals(Math.round(clusters[0].lng * 10) / 10, 20.2);
  assertEquals(clusters[1].count, 1);
  assertEquals(clusters[1].singleId, 'c');
});

Deno.test('a single point carries its id while every cell retains its members internally', () => {
  const clusters = clusterPoints([point('a', 0.1, 0.1), point('b', 0.2, 0.2)], 1);

  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].singleId, undefined);
  assertEquals(clusters[0].memberIds, ['a', 'b']);
});

Deno.test('coincident points are one cluster, not one marker each', () => {
  // Photos taken from one spot share a coordinate exactly.
  const same = clusterPoints([point('a', 0.5, 0.5), point('b', 0.5, 0.5)], 1);

  assertEquals(same.length, 1);
  assertEquals(same[0].count, 2);
  assertEquals(same[0].lat, 0.5);
});

Deno.test('cell boundaries and negative coordinates floor consistently', () => {
  // 1.0 belongs to the cell above 0.9, and -0.1 to the one below 0.
  const clusters = clusterPoints([point('a', 0.9, 0), point('b', 1.0, 0), point('c', -0.1, 0)], 1);
  assertEquals(clusters.map((cluster) => cluster.count), [1, 1, 1]);
  assertEquals(new Set(clusters.map((cluster) => cluster.key)).size, 3);
});

Deno.test('clusters come back biggest first, then stably by key', () => {
  const clusters = clusterPoints([
    point('a', 0.5, 0.5),
    point('b', 5.5, 5.5),
    point('c', 5.6, 5.6),
    point('d', 9.5, 9.5),
  ], 1);

  assertEquals(clusters.map((cluster) => cluster.count), [2, 1, 1]);
  assertEquals(clusters[1].key < clusters[2].key, true);
});

Deno.test('no points is no clusters', () => {
  assertEquals(clusterPoints([], 0.5), []);
});
