/**
 * Pure-unit tests for auto-album scoring primitives + member keys. Fast tier:
 * no PG, no media tools, no VFS.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  combineScores,
  DEFAULT_LOCATION_SCALE_M,
  DEFAULT_TIME_HALFLIFE_MS,
  DEFAULT_WEIGHTS,
  haversineMeters,
  jaccard,
  locationSimilarity,
  temporalSimilarity,
} from '../../lib/staging/scoring.ts';
import { type AutoAlbumMeta, fnv1a64, isMemberKey, isUserEdited, memberKeyOf, toggleMembers } from '../../lib/staging/auto-album.ts';

Deno.test('temporalSimilarity decays by half every half-life', () => {
  assertEquals(temporalSimilarity(0), 1);
  assertAlmostEquals(temporalSimilarity(DEFAULT_TIME_HALFLIFE_MS), 0.5, 1e-9);
  assertAlmostEquals(temporalSimilarity(2 * DEFAULT_TIME_HALFLIFE_MS), 0.25, 1e-9);
  // sign-independent
  assertEquals(temporalSimilarity(-DEFAULT_TIME_HALFLIFE_MS), temporalSimilarity(DEFAULT_TIME_HALFLIFE_MS));
});

Deno.test('locationSimilarity is 1 at zero and 1/e at scale', () => {
  assertEquals(locationSimilarity(0), 1);
  assertAlmostEquals(locationSimilarity(DEFAULT_LOCATION_SCALE_M), 1 / Math.E, 1e-9);
});

Deno.test('haversineMeters matches known distances', () => {
  // same point
  assertEquals(haversineMeters(59.33, 18.06, 59.33, 18.06), 0);
  // ~1 deg latitude ≈ 111 km
  const d = haversineMeters(59, 18, 60, 18);
  assertAlmostEquals(d, 111195, 500);
});

Deno.test('jaccard overlap', () => {
  assertEquals(jaccard([], []), 0);
  assertEquals(jaccard(['a', 'b'], ['a', 'b']), 1);
  assertEquals(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assertEquals(jaccard(['a'], ['b']), 0);
});

Deno.test('combineScores renormalizes over present signals only', () => {
  // Only temporal+location present -> weighted mean over those two weights.
  const s = combineScores({ temporal: 1, location: 0 });
  const expected = (1 * DEFAULT_WEIGHTS.temporal + 0 * DEFAULT_WEIGHTS.location) /
    (DEFAULT_WEIGHTS.temporal + DEFAULT_WEIGHTS.location);
  assertAlmostEquals(s, expected, 1e-9);
  // All equal -> that value regardless of weights
  assertAlmostEquals(combineScores({ temporal: 0.8, location: 0.8, people: 0.8 }), 0.8, 1e-9);
  // Nothing present -> 0
  assertEquals(combineScores({}), 0);
});

Deno.test('fnv1a64 is FNV-1a over 64 bits', () => {
  assertEquals(fnv1a64(''), 0xcbf29ce484222325n);
  assertEquals(fnv1a64('a'), 0xaf63dc4c8601ec8cn);
  assertEquals(fnv1a64('foobar'), 0x85944171f73967e8n);
});

Deno.test('memberKeyOf is order-independent and set-based, 16 hex digits', () => {
  const [a, b, c] = ['01J0000000000000000000000A', '01J0000000000000000000000B', '01J0000000000000000000000C'];
  assertEquals(memberKeyOf([a, b, c]), memberKeyOf([c, a, b]));
  assertEquals(memberKeyOf([a, a, b]), memberKeyOf([a, b]));
  assertEquals(memberKeyOf([a, b]) === memberKeyOf([a, c]), false);
  assertEquals(memberKeyOf([]), '0000000000000000');
  assertEquals(isMemberKey(memberKeyOf([a])), true);
  assertEquals(isMemberKey('1a2b3c4d'), false);
});

Deno.test('a member leaving or joining toggles only its own hash', () => {
  const [a, b, c] = ['01J0000000000000000000000A', '01J0000000000000000000000B', '01J0000000000000000000000C'];
  assertEquals(toggleMembers(memberKeyOf([a, b, c]), [b]), memberKeyOf([a, c]));
  assertEquals(toggleMembers(memberKeyOf([a]), [b, c]), memberKeyOf([a, b, c]));
  // Members {a, b, c} where c was linked by hand: the stored key is still {a, b}'s. Once a leaves,
  // the stored key still disagrees with the members {b, c}, so the hand edit stays visible.
  const stored = toggleMembers(memberKeyOf([a, b]), [a]);
  assertEquals(stored, memberKeyOf([b]));
  assertEquals(stored === memberKeyOf([b, c]), false);
});

Deno.test('with a member link dangling, an album is judged by its link count', () => {
  const [a, b, c, d] = ['01J0000000000000000000000A', '01J0000000000000000000000B', '01J0000000000000000000000C', '01J0000000000000000000000D'];
  const meta = { memberKey: memberKeyOf([a, b, c]), memberCount: 3, generatedAt: '', generatedBy: '', timeStart: '', timeEnd: '' } satisfies AutoAlbumMeta;
  assertEquals(isUserEdited({ autoAlbum: meta }, [a, b, c]), false);
  // c's file was deleted: its link is still there, so the album is as the clusterer left it.
  assertEquals(isUserEdited({ autoAlbum: meta }, [a, b, undefined]), false);
  // ... and a link added by hand, or one removed, still shows.
  assertEquals(isUserEdited({ autoAlbum: meta }, [a, b, undefined, d]), true);
  assertEquals(isUserEdited({ autoAlbum: meta }, [a, undefined]), true);
});
