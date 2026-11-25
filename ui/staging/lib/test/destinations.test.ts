import type { StagingAlbumRef } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { parseRecent, proposalLabel, RECENT_MAX, selectedAlbum, withRecent } from '../destinations.ts';

const summer = { path: '/archive/albums/summer', title: 'Summer 2019' };
const lake = { path: '/archive/albums/lake', title: 'Lake trip 2019' };
const prints: StagingAlbumRef = {
  id: 'd',
  path: '/archive/albums/prints',
  title: 'Family prints',
  ownership: { uid: 1, gid: 1, mode: 0o750 },
  writable: true,
};

Deno.test('what is kept reads back, and anything else is nothing', () => {
  assertEquals(parseRecent(JSON.stringify([lake, { path: 2 }, summer])), [lake, summer]);
  assertEquals(parseRecent('[oops'), []);
});

Deno.test('the recent albums keep the newest first, once each, eight at most', () => {
  let recent = withRecent([], summer);
  recent = withRecent(recent, lake);
  recent = withRecent(recent, summer);
  assertEquals(recent, [summer, lake]);
  for (let i = 0; i < 20; i++) recent = withRecent(recent, { path: `/a/${i}`, title: `${i}` });
  assertEquals(recent.length, RECENT_MAX);
  assertEquals(recent[0].path, '/a/19');
});

Deno.test('a proposal in the words of its button', () => {
  assertEquals(proposalLabel({ action: 'existing', album: prints, confidence: 'medium', reason: 'match' }), 'Add to “Family prints”');
  assertEquals(proposalLabel({ action: 'new', title: 'Lake weekend', confidence: 'low', compared: false }), 'Create album “Lake weekend”');
  assertEquals(proposalLabel({ action: 'none' }), undefined);
});

Deno.test('the column selects the album picked while it offers it, else the first candidate', () => {
  assertEquals(selectedAlbum(null, [prints, summer], [lake]), prints);
  assertEquals(selectedAlbum(summer.path, [prints, summer], [lake]), summer);
  assertEquals(selectedAlbum(lake.path, [prints], [lake]), lake);
  // One no longer offered (rejected, or the cursor moved on) gives way to the first candidate.
  assertEquals(selectedAlbum('/archive/albums/gone', [prints], [lake]), prints);
  assertEquals(selectedAlbum(null, [], [lake]), undefined);
});
