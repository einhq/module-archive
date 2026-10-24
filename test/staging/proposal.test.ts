/** The proposal rule: where a group is proposed to go, and how sure that is. */
import type { StagingAlbumRef, StagingRowInfo } from '@archive/staging/api';
import { atLeast, proposalInputOf, proposeDestination } from '@archive/staging/proposal';
import { assertEquals } from '@std/assert';

const album = (title: string, writable = true): StagingAlbumRef => ({
  id: `id-${title}`,
  path: `/archive/albums/${title}`,
  title,
  ownership: { uid: 3400, gid: 7200, mode: 0o750 },
  writable,
});

Deno.test('an event without a match or a target is a new album under its title, unsure', () => {
  assertEquals(proposeDestination({ title: 'Lake weekend' }), { action: 'new', title: 'Lake weekend', confidence: 'low', compared: false });
  assertEquals(proposeDestination({ kind: 'event', title: 'Lake weekend' }).action, 'new');
  assertEquals(proposeDestination({ kind: 'trip', title: 'Coast trip' }).action, 'new');
});

Deno.test('a sure or likely match the reader may file into wins', () => {
  const top = { album: album('Lake trip 2019'), p: 0.82 };
  assertEquals(proposeDestination({ title: 'Lake weekend', matched: true, top, matchConfidence: 'high' }), {
    action: 'existing',
    album: top.album,
    confidence: 'high',
    reason: 'match',
  });
  assertEquals(proposeDestination({ title: 'Lake weekend', matched: true, top, matchConfidence: 'medium' }).action, 'existing');
  assertEquals(proposeDestination({ title: 'Lake weekend', matched: true, top, matchConfidence: 'low' }).action, 'new');
});

Deno.test('compared and nothing fits: a new album, sure for a happening of its own, likely otherwise', () => {
  const compared = { title: 'Coast trip', matched: true, matchConfidence: 'low' as const };
  assertEquals(proposeDestination({ ...compared, kind: 'trip', significance: 'trip', matchNew: 0.95 }), {
    action: 'new',
    title: 'Coast trip',
    confidence: 'high',
    compared: true,
  });
  assertEquals(proposeDestination({ ...compared, kind: 'event', significance: 'size', matchNew: 0.95 }).action === 'new', true);
  assertEquals((proposeDestination({ ...compared, kind: 'event', significance: 'size', matchNew: 0.95 }) as { confidence: string }).confidence, 'medium');
  assertEquals((proposeDestination({ ...compared, kind: 'event', matchNew: 0.3 }) as { confidence: string }).confidence, 'low');
  // Not compared: a guess, whatever the significance.
  assertEquals((proposeDestination({ kind: 'trip', title: 'Coast trip', significance: 'trip' }) as { confidence: string }).confidence, 'low');
});

Deno.test('a match the reader may not file into is passed over for the category target', () => {
  const top = { album: album('Grandparents 2019', false), p: 0.9 };
  const target = album('Summer 2019');
  assertEquals(proposeDestination({ title: 'Lake weekend', matched: true, top, matchConfidence: 'high', categoryTarget: target }), {
    action: 'existing',
    album: target,
    confidence: 'medium',
    reason: 'category',
  });
  assertEquals(proposeDestination({ title: 'Lake weekend', matched: true, top, matchConfidence: 'high' }).action, 'new');
});

Deno.test('a category target the reader may not file into is no proposal of it', () => {
  assertEquals(proposeDestination({ title: 'Lake weekend', categoryTarget: album('Family prints', false) }).action, 'new');
  assertEquals(proposeDestination({ title: 'Lake weekend', categoryTarget: null }).action, 'new');
});

Deno.test("an Everyday lane files its matched days; without any, it goes to the category's destination or nowhere", () => {
  assertEquals(proposeDestination({ kind: 'loose', title: 'Everyday · 2014', partsMatched: { parts: 6, files: 140 }, categoryTarget: album('Family prints') }), {
    action: 'parts',
    parts: 6,
    files: 140,
    confidence: 'medium',
  });
  assertEquals(proposeDestination({ kind: 'loose', title: 'Everyday · 2014', partsMatched: { parts: 0, files: 0 }, categoryTarget: album('Family prints') }), {
    action: 'existing',
    album: album('Family prints'),
    confidence: 'medium',
    reason: 'category',
  });
  for (const kind of ['loose', 'undated'] as const) {
    assertEquals(proposeDestination({ kind, title: 'Everyday · 2014' }), { action: 'none' });
    assertEquals(proposeDestination({ kind, title: 'Everyday · 2014', categoryTarget: album('Family prints', false) }), { action: 'none' });
  }
  // An undated lane has no days to match.
  assertEquals(proposeDestination({ kind: 'undated', title: 'Undated · box', partsMatched: { parts: 2, files: 9 } }), { action: 'none' });
});

Deno.test('clutter is proposed for the trash, never filed', () => {
  assertEquals(proposeDestination({ kind: 'clutter', title: 'Screenshots · 2019', categoryTarget: album('Family prints') }), { action: 'discard', confidence: 'medium' });
});

Deno.test('a seed is a new album under its label, sure, unless a sure match says otherwise', () => {
  assertEquals(proposeDestination({ kind: 'seed', title: 'Lake trip', categoryTarget: album('Family prints') }), {
    action: 'new',
    title: 'Lake trip',
    confidence: 'high',
    compared: false,
  });
  const top = { album: album('Lake trip 2019'), p: 0.9 };
  assertEquals(proposeDestination({ kind: 'seed', title: 'Lake trip', matched: true, top, matchConfidence: 'medium' }).action, 'new');
  assertEquals(proposeDestination({ kind: 'seed', title: 'Lake trip', matched: true, top, matchConfidence: 'high' }).action, 'existing');
});

Deno.test('a scan run goes to a sure match, the target, or a new album', () => {
  assertEquals(proposeDestination({ kind: 'folder', title: 'Box 3' }), { action: 'new', title: 'Box 3', confidence: 'low', compared: false });
  assertEquals(proposeDestination({ kind: 'folder', title: 'Box 3', categoryTarget: album('Family prints') }).action, 'existing');
  const top = { album: album('Prints 1975'), p: 0.7 };
  assertEquals(proposeDestination({ kind: 'folder', title: 'Box 3', matched: true, top, matchConfidence: 'medium' }).action, 'new');
});

Deno.test("the rule's input from a row: a seed under its label, the matches as stored", () => {
  const staging: StagingRowInfo = {
    memberKey: '0f3a9c2b4d5e6f70',
    kind: 'seed',
    seed: 'Lake trip',
    matchedAt: '2026-10-01T10:00:00Z',
    matchConfidence: 'low',
    matchNew: 0.9,
  };
  assertEquals(proposalInputOf('Lake trip · Lakeside', staging, null), {
    kind: 'seed',
    title: 'Lake trip',
    matched: true,
    matchConfidence: 'low',
    matchNew: 0.9,
    categoryTarget: null,
  });
  assertEquals(proposalInputOf('Midsummer eve', { memberKey: '0f3a9c2b4d5e6f70' }).matched, false);
});

Deno.test('a confidence floor', () => {
  const likely = proposeDestination({ title: 'Lake weekend', categoryTarget: album('Summer 2019') });
  assertEquals([atLeast(likely, 'medium'), atLeast(likely, 'high')], [true, false]);
  assertEquals(atLeast(proposeDestination({ title: 'Lake weekend' }), 'medium'), false);
  assertEquals(atLeast({ action: 'none' }, 'medium'), false);
});

Deno.test("a group mostly of copies of library photos keeps the library's, sure, before any other rule", () => {
  const top = { album: album('Lake trip 2019'), p: 0.9 };
  assertEquals(proposeDestination({ title: 'Lake weekend', top, matchConfidence: 'high', members: 10, libraryDuplicates: 8 }), {
    action: 'dedupe',
    files: 8,
    confidence: 'high',
  });
  assertEquals(proposeDestination({ kind: 'clutter', title: 'Screenshots', members: 5, libraryDuplicates: 5 }).action, 'dedupe');
  assertEquals(proposeDestination({ title: 'Lake weekend', top, matchConfidence: 'high', members: 10, libraryDuplicates: 7 }).action, 'existing', 'some copies are not most');
  assertEquals(proposeDestination({ title: 'Lake weekend', libraryDuplicates: 8 }).action, 'new', 'unknown until the group is open');
  assertEquals(proposeDestination({ title: 'Lake weekend', members: 0, libraryDuplicates: 0 }).action, 'new');
  const staging: StagingRowInfo = { memberKey: 'k', kind: 'event' } as StagingRowInfo;
  assertEquals(proposeDestination(proposalInputOf('Lake weekend', staging, null, { members: 4, libraryDuplicates: 4 })).action, 'dedupe');
});
