import { assertEquals, assertStrictEquals } from '@std/assert';
import { appendFixes, formatAge, isLive, LIVE_FOR_MS, speedOf } from '../live.ts';

const at = (ts: string, lat = 57.7, lng = 11.9, speed?: number) => ({ lat, lng, ts, ...(speed === undefined ? {} : { speed }) });

Deno.test('live: a track is live while its last fix is younger than four hours', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  assertEquals(isLive('2026-07-01T11:59:00Z', now), true);
  assertEquals(isLive(new Date(now - LIVE_FOR_MS + 1000).toISOString(), now), true);
  assertEquals(isLive(new Date(now - LIVE_FOR_MS).toISOString(), now), false);
  assertEquals(isLive(undefined, now), false);
});

Deno.test('live: only fixes newer than the last one are appended, in time order', () => {
  const points = [at('2026-07-01T10:00:00Z')];
  const next = appendFixes(points, [at('2026-07-01T10:00:10Z'), at('2026-07-01T10:00:00Z'), at('2026-07-01T10:00:05Z')]);
  assertEquals(next.map((point) => point.ts), ['2026-07-01T10:00:00Z', '2026-07-01T10:00:05Z', '2026-07-01T10:00:10Z']);
});

Deno.test('live: nothing new returns the same array', () => {
  const points = [at('2026-07-01T10:00:00Z')];
  assertStrictEquals(appendFixes(points, [at('2026-07-01T10:00:00Z')]), points);
  assertStrictEquals(appendFixes(points, []), points);
});

Deno.test('live: the reported speed wins over the one worked out from the fixes', () => {
  assertEquals(speedOf([at('2026-07-01T10:00:00Z', 57.7), at('2026-07-01T10:01:00Z', 57.71, 11.9, 2.5)]), 2.5);
});

Deno.test('live: without a reported speed it is the distance over the time between the last two fixes', () => {
  // 0.01° of latitude is about 1112 m; over 100 s that is about 11 m/s.
  const speed = speedOf([at('2026-07-01T10:00:00Z', 57.7), at('2026-07-01T10:01:40Z', 57.71)])!;
  assertEquals(Math.round(speed), 11);
  assertEquals(speedOf([at('2026-07-01T10:00:00Z', 57.7), at('2026-07-01T11:00:00Z', 57.71)]), undefined);
  assertEquals(speedOf([at('2026-07-01T10:00:00Z')]), undefined);
});

Deno.test('live: age reads as a person says it', () => {
  assertEquals(formatAge(4000), 'just now');
  assertEquals(formatAge(40_000), '40 s ago');
  assertEquals(formatAge(12 * 60_000 + 5000), '12 min ago');
  assertEquals(formatAge(125 * 60_000), '2 h 5 min ago');
  assertEquals(formatAge(120 * 60_000), '2 h ago');
});
