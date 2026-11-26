/**
 * A suggested group's row and details offer only the candidates the reader can see that are at
 * least `OFFERED_MIN_P` likely: Add to existing lists them, and its button counts them.
 */
import type { StagingAlbumRef, StagingMatchCandidate } from '@archive/staging/api';
import { groupDetailOf, type GroupRowAttrs, OFFERED_MIN_P, stagingRowOf } from '@archive/staging/rows';
import { assertEquals } from '@std/assert';

const ref = (id: string): StagingAlbumRef => ({ id, path: `/home/anna/albums/${id}`, title: id, ownership: { mode: 0o644, uid: 1000, gid: 1000 }, writable: true });

const candidate = (albumId: string, score: number): StagingMatchCandidate => ({ albumId, score, margin: 0, reasons: [], evidence: {}, writable: true });

const attrs = (candidates: StagingMatchCandidate[]): GroupRowAttrs => ({
  autoAlbum: { memberKey: 'k', memberCount: 10, generatedAt: '2026-11-25T00:00:00Z', generatedBy: 'test' },
  stagingMatches: {
    computedAt: '2026-11-25T00:00:00Z',
    memberKey: 'k',
    model: 'm',
    proposal: 'existing' as const,
    confidence: 'medium' as const,
    newAlbum: 0,
    visual: false,
    candidates,
  },
});

Deno.test('candidates below the floor are neither listed nor counted', () => {
  const group = attrs([candidate('summer', 0.81), candidate('beach', OFFERED_MIN_P), candidate('garden', 0.02)]);
  const refs = new Map(['summer', 'beach', 'garden'].map((id) => [id, ref(id)]));
  assertEquals(groupDetailOf(group, refs).candidates.map((each) => each.album.id), ['summer', 'beach']);
  assertEquals(stagingRowOf(group, refs)?.candidates, 2);
});

Deno.test('a group whose candidates are all unlikely offers none, though its best match stays its top', () => {
  const group = attrs([candidate('summer', 0.3), candidate('garden', 0.02)]);
  const refs = new Map(['summer', 'garden'].map((id) => [id, ref(id)]));
  assertEquals(groupDetailOf(group, refs).candidates, []);
  const row = stagingRowOf(group, refs);
  assertEquals(row?.candidates, undefined);
  assertEquals(row?.top?.album.id, 'summer');
});

Deno.test('an album the reader cannot see is not offered, however likely', () => {
  const group = attrs([candidate('hidden', 0.9), candidate('summer', 0.6)]);
  const refs = new Map([['summer', ref('summer')]]);
  assertEquals(groupDetailOf(group, refs).candidates.map((each) => each.album.id), ['summer']);
  assertEquals(stagingRowOf(group, refs)?.candidates, 1);
});
