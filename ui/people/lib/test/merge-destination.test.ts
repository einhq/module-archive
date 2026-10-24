import { assertEquals } from '@std/assert';
import { mergeDestination } from '../merge-destination.ts';

const person = (path: string, faceCount: number, createdAt?: string) => ({ path, faceCount, createdAt });

Deno.test('merge destination: the biggest cluster survives', () => {
  const picked = mergeDestination([person('/a', 3), person('/b', 312), person('/c', 12)]);
  assertEquals(picked?.path, '/b');
});

Deno.test('merge destination: equal counts go to the older cluster', () => {
  // Without a tie-break the survivor would depend on the order the grid happened to be in,
  // so the confirm dialog could name a different person after a refetch.
  const older = person('/older', 5, '2026-01-02T00:00:00Z');
  const newer = person('/newer', 5, '2026-06-01T00:00:00Z');
  assertEquals(mergeDestination([newer, older])?.path, '/older');
  assertEquals(mergeDestination([older, newer])?.path, '/older');
});

Deno.test('merge destination: a cluster with no createdAt still ranks', () => {
  assertEquals(mergeDestination([person('/a', 5), person('/b', 5, '2026-01-01T00:00:00Z')])?.path, '/a');
  assertEquals(mergeDestination([] as ReturnType<typeof person>[]), undefined);
});

Deno.test('merge destination: the input list is left alone', () => {
  const people = [person('/a', 1), person('/b', 9)];
  mergeDestination(people);
  assertEquals(people.map((p) => p.path), ['/a', '/b'], 'sorting in place would reorder the grid');
});
