/**
 * What a duplicate read is asked about (`@archive/staging/duplicate-read`): the folder it reads,
 * which is the inbox's `files/` or under it, or a suggested group, and the keys that name sets by
 * their originals or their anchors.
 */
import { duplicateScope, isGroupPath, isSetKey, parseSetKey, setKey } from '@archive/staging/duplicate-read';
import { dedupeScope } from '@archive/staging/dedupe';
import { assertEquals, assertThrows } from '@std/assert';

Deno.test("a read's scope is the inbox's files or a folder under them", () => {
  assertEquals(duplicateScope('anna', '/home/anna/staging/files/'), { user: 'anna', path: '/home/anna/staging/files', whole: true });
  assertEquals(duplicateScope('anna', '/home/anna/staging/files/inbox/upload'), { user: 'anna', path: '/home/anna/staging/files/inbox/upload', whole: false });
  assertThrows(() => duplicateScope('anna', '/home/bob/staging/files/inbox'), Error, "not in anna's staging files");
  assertThrows(() => duplicateScope('anna', '/home/anna/staging/albums/inbox'), Error, 'not in');
  assertThrows(() => duplicateScope('anna', '/archive/albums'), Error, 'not in');
});

Deno.test('a dedupe works in one category', () => {
  assertEquals(dedupeScope('anna', '/home/anna/staging/files/scans/box-3').category, 'scans');
  assertThrows(() => dedupeScope('anna', '/home/anna/staging/files'), Error, 'one category');
});

Deno.test('a set key names its original or its anchor', () => {
  assertEquals([setKey('exact', '01JA'), setKey('near', '01JB')], ['exact:01JA', 'near:01JB']);
  assertEquals([parseSetKey('exact:01JA'), parseSetKey('near:01JB')], [{ kind: 'exact', id: '01JA' }, { kind: 'near', id: '01JB' }]);
  assertEquals([isSetKey('exact:01JA'), isSetKey('near:01JB'), isSetKey('inbox'), isSetKey('/home/anna/staging/files/inbox')], [true, true, false, false]);
  assertThrows(() => parseSetKey('exact:'), Error, 'not a duplicate set');
  assertThrows(() => parseSetKey('variant:01JA'), Error, 'not a duplicate set');
});

Deno.test('a suggested group is a scope of its own', () => {
  assertEquals(isGroupPath('anna', '/home/anna/staging/albums/inbox/2019-06-14'), true);
  assertEquals(isGroupPath('anna', '/home/anna/staging/albums/inbox/.organizer'), false);
  assertEquals(isGroupPath('anna', '/home/anna/staging/albums/inbox'), false);
  assertEquals(isGroupPath('anna', '/home/bob/staging/albums/inbox/2019-06-14'), false);
});
