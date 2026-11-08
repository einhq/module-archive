/**
 * `album-track-list`, `-add` and `-rm`: an album lists the tracks the cameras of its media record
 * into and the ones added by hand, a track taken off stays off as more of its media joins, and the
 * list never counts as a member.
 */

import { ALBUMS_ROOT, CAMERAS_ROOT } from '@archive/paths';
import type { AlbumTrackList } from '@archive/media/api';
import type { ContainerListing } from '@ein/client';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { historyOf, mkTracker } from '../location/tracker.ts';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

Deno.test({
  name: 'album tracks',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const album = `${ALBUMS_ROOT}/sailing`;
  const camera = `${CAMERAS_ROOT}/camera`;
  const phone = `${CAMERAS_ROOT}/phone`;
  const scanner = `${CAMERAS_ROOT}/scanner`;
  const boat = historyOf('sailboat');
  const pocket = historyOf('anna-phone');
  const hiking = historyOf('hiking-gps');

  const photo = async (path: string, camera: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', cameraPath: camera } });
  };
  const list = () => client.execJson<AlbumTrackList>(`album-track-list ${album}`);
  const listed = async () => (await list()).tracks.map(({ path, source, media }) => ({ path, source, media }));

  try {
    for (const root of [CAMERAS_ROOT, ALBUMS_ROOT, '/elsewhere']) await cmd.shouldSucceed(`mkdir -p ${root}`);
    await cmd.shouldSucceed(mkTracker('sailboat', 'Sailboat'));
    await cmd.shouldSucceed(mkTracker('anna-phone', 'Anna Andersson'));
    await cmd.shouldSucceed(mkTracker('hiking-gps', 'Hiking GPS'));
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'camera', { attrs: { name: 'Example Camera' } });
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'phone', { attrs: { name: 'Example Phone' } });
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'scanner', { attrs: { name: 'Example Scanner' } });
    await cmd.shouldSucceed(`camera-track camera ${boat} && camera-track phone anna-phone`);
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'sailing', { attrs: { name: 'Sailing' } });
    await photo(`${album}/a.jpg`, camera);
    await photo(`${album}/b.jpg`, camera);
    await photo(`${album}/c.jpg`, phone);
    // A camera that records into no track adds none.
    await photo(`${album}/s.jpg`, scanner);

    await t.step('the tracks the cameras of its media record into, the most media first', async () => {
      assertEquals(await listed(), [
        { path: boat, source: 'media', media: 2 },
        { path: pocket, source: 'media', media: 1 },
      ]);
      assertEquals((await list()).tracks.map((track) => track.name), ['Sailboat', 'Anna Andersson']);
      assertEquals((await list()).removed, []);
    });

    await t.step('a track added by hand is linked from tracks/ and listed after them', async () => {
      await cmd.shouldSucceed(`album-track-add ${album} hiking-gps`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${album}/tracks/hiking-gps`, { readlink: true })).props.softlink, hiking);
      assertEquals((await listed()).at(-1), { path: hiking, source: 'added', media: 0 });
      // A track of its media is on the list already, and gets no link.
      await cmd.shouldSucceed(`album-track-add ${album} ${boat}`);
      assertEquals((await vfs.children(ADMIN_ACCESS, `${album}/tracks`, { follow: false })).map((entry) => entry.name), ['hiking-gps']);
    });

    await t.step('the list is not a member', async () => {
      const members = await client.execJson<ContainerListing>(`members ${album}`);
      assertEquals(members.members.length, 4);
    });

    await t.step('a track of its media taken off stays off as more of its media joins', async () => {
      await cmd.shouldSucceed(`album-track-rm ${album} ${pocket}`);
      await photo(`${album}/d.jpg`, phone);
      assertEquals((await listed()).map((track) => track.path), [boat, hiking]);
      assertEquals((await list()).removed.map(({ path, media }) => ({ path, media })), [{ path: pocket, media: 2 }]);
      await cmd.shouldSucceed(`album-track-add ${album} anna-phone`);
      // Two pictures each: the names decide.
      assertEquals((await listed()).map((track) => track.path), [pocket, boat, hiking]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a track added by hand and taken off is gone, and the last one takes tracks/ with it', async () => {
      await cmd.shouldSucceed(`album-track-rm ${album} hiking-gps`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/tracks`, { follow: false }), false);
      assertEquals((await listed()).map((track) => track.path), [pocket, boat]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a folder that is not an album lists the tracks of its media', async () => {
      await photo('/elsewhere/e.jpg', phone);
      const folder = await client.execJson<AlbumTrackList>('album-track-list /elsewhere');
      assertEquals(folder.tracks.map(({ path, source, media }) => ({ path, source, media })), [{ path: pocket, source: 'media', media: 1 }]);
    });

    await t.step('only an album takes a track, and only a track', async () => {
      await cmd.shouldFailWith(`album-track-add /elsewhere hiking-gps`, 'not an album');
      await cmd.shouldFailWith(`album-track-add ${album} ${album}/a.jpg`, 'has no track');
      await cmd.shouldFailWith(`album-track-add ${album} missing`, 'no device or camera of that name');
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
