import { assertEquals, assertThrows } from '@std/assert';
import {
  categoryAlbumsPath,
  categoryPath,
  groupsDirOf,
  isStagedPath,
  isStagingGroup,
  parseStagedPath,
  stagedPlace,
  stagingGroupOf,
  stagingRoots,
  uploadPathFor,
} from '@archive/staging/paths';
import { leavesStaging } from '@archive/staging';

Deno.test('staging roots: every directory of the area, for a name that is one path segment', () => {
  assertEquals(stagingRoots('person@example.com'), {
    homePath: '/home/person@example.com',
    stagingPath: '/home/person@example.com/staging',
    filesPath: '/home/person@example.com/staging/files',
    albumsPath: '/home/person@example.com/staging/albums',
    journalPath: '/home/person@example.com/staging/journal',
    routesPath: '/home/person@example.com/staging/routes',
  });
  assertThrows(() => stagingRoots('..'));
  assertThrows(() => stagingRoots('anna/bertil'));
  assertEquals(categoryPath('anna', 'scans'), '/home/anna/staging/files/scans');
  assertEquals(categoryAlbumsPath('anna', 'scans'), '/home/anna/staging/albums/scans');
  assertEquals(uploadPathFor('/home/anna/staging/files/inbox', '2026-10-16'), '/home/anna/staging/files/inbox/upload-2026-10-16');
  assertThrows(() => uploadPathFor('/home/anna/staging/files/inbox', '16/10/2026'));
});

Deno.test('parseStagedPath takes a path apart at every depth', () => {
  assertEquals(parseStagedPath('/home/anna/staging'), { user: 'anna', area: 'root', rest: '' });
  assertEquals(parseStagedPath('/home/anna/staging/files'), { user: 'anna', area: 'files', rest: '' });
  assertEquals(parseStagedPath('/home/anna/staging/files/inbox'), { user: 'anna', area: 'files', category: 'inbox', rest: '' });
  assertEquals(parseStagedPath('/home/anna/staging/files/inbox/upload-2026-10-16/Trip/IMG_1.jpg'), {
    user: 'anna',
    area: 'files',
    category: 'inbox',
    rest: 'upload-2026-10-16/Trip/IMG_1.jpg',
  });
  assertEquals(parseStagedPath('/home/anna/staging/albums/scans/box-3/'), { user: 'anna', area: 'albums', category: 'scans', rest: 'box-3' });
  assertEquals(parseStagedPath('/home/anna/staging/routes/hike.gpx'), { user: 'anna', area: 'routes', rest: 'hike.gpx' });
  assertEquals(parseStagedPath('/home/anna/staging/notes.txt'), { user: 'anna', area: 'other', rest: '' });
  assertEquals(parseStagedPath('/home/anna/photos/IMG_1.jpg'), undefined);
  assertEquals(parseStagedPath('/archive/albums/trip/IMG_1.jpg'), undefined);
});

Deno.test('stagedPlace and groupsDirOf name the category of anything within one', () => {
  assertEquals(stagedPlace('/home/anna/staging/files/scans/box-3/scan0001.tif'), { user: 'anna', category: 'scans' });
  assertEquals(stagedPlace('/home/anna/staging/files/inbox/IMG_1.jpg'), { user: 'anna', category: 'inbox' });
  assertEquals(stagedPlace('/home/anna/staging/files/inbox'), undefined);
  assertEquals(stagedPlace('/home/anna/staging/albums/inbox/day'), undefined);
  assertEquals(groupsDirOf('/home/anna/staging/files/scans/box-3/scan0001.tif'), '/home/anna/staging/albums/scans');
  assertEquals(groupsDirOf('/home/anna/staging/routes/hike.gpx'), undefined);
  // An entry loose in files/, outside every category, is staged but joins no groups.
  assertEquals(isStagedPath('/home/anna/staging/files/IMG_1.jpg'), true);
  assertEquals(groupsDirOf('/home/anna/staging/files/IMG_1.jpg'), undefined);
});

Deno.test('a suggested group is albums/<category>/<slug>, and what lies under it belongs to it', () => {
  assertEquals(isStagingGroup('/home/anna/staging/albums/inbox/2019-06-14'), true);
  assertEquals(isStagingGroup('/home/anna/staging/albums/inbox'), false);
  assertEquals(isStagingGroup('/home/anna/staging/albums/inbox/.organizer'), false);
  assertEquals(isStagingGroup('/home/anna/staging/albums/inbox/2019-06-14/IMG_1.jpg'), false);
  assertEquals(isStagingGroup('/home/anna/staging/files/inbox/2019-06-14'), false);
  assertEquals(stagingGroupOf('/home/anna/staging/albums/inbox/2019-06-14/IMG_1.jpg'), '/home/anna/staging/albums/inbox/2019-06-14');
  assertEquals(stagingGroupOf('/home/anna/staging/albums/inbox/2019-06-14'), '/home/anna/staging/albums/inbox/2019-06-14');
  assertEquals(stagingGroupOf('/home/anna/staging/albums/inbox'), undefined);
});

Deno.test('a staged file at any depth leaves staging for a library album, and stays for its own groups', () => {
  assertEquals(leavesStaging('/home/anna/staging/files/inbox/upload-2026-10-16/x.jpg', '/archive/albums/trip'), true);
  assertEquals(leavesStaging('/home/anna/staging/files/inbox/legacy-import/x.jpg', '/archive/albums/trip/files'), true);
  assertEquals(leavesStaging('/home/anna/staging/files/inbox/x.jpg', '/home/anna/staging/albums/inbox/day'), false);
  assertEquals(leavesStaging('/archive/albums/other/x.jpg', '/archive/albums/trip'), false);
  // Another user's staging is not the file's own.
  assertEquals(leavesStaging('/home/anna/staging/files/inbox/x.jpg', '/home/bertil/staging/albums/inbox/day'), true);
});
