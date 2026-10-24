import type { StagingAlbumRef } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { parseRecent, parseTarget, proposalLabel, RECENT_MAX, stickyTarget, withRecent } from '../destinations.ts';

const summer = { path: '/archive/albums/summer', title: 'Summer 2019' };
const lake = { path: '/archive/albums/lake', title: 'Lake trip 2019' };
const destination = (writable: boolean): StagingAlbumRef => ({
  id: 'd',
  path: '/archive/albums/prints',
  title: 'Family prints',
  ownership: { uid: 1, gid: 1, mode: 0o750 },
  writable,
});

Deno.test('what is kept reads back, and anything else is nothing', () => {
  assertEquals(parseTarget(JSON.stringify(summer)), summer);
  assertEquals([parseTarget(''), parseTarget('{"path":1}'), parseTarget('not json')], [null, null, null]);
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

Deno.test('the target is the one chosen, else the destination one may file into, else the last used', () => {
  assertEquals(stickyTarget(lake, destination(true), [summer]), lake);
  assertEquals(stickyTarget(null, destination(true), [summer]), { path: '/archive/albums/prints', title: 'Family prints' });
  assertEquals(stickyTarget(null, destination(false), [summer]), summer);
  assertEquals(stickyTarget(null, null, []), null);
});

Deno.test('a proposal in the words of its button', () => {
  assertEquals(proposalLabel({ action: 'existing', album: destination(true), confidence: 'medium', reason: 'category' }), 'Add to “Family prints”');
  assertEquals(proposalLabel({ action: 'new', title: 'Lake weekend', confidence: 'low', compared: false }), 'New album “Lake weekend”');
  assertEquals(proposalLabel({ action: 'none' }), undefined);
});
