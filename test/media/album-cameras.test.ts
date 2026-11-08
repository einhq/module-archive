/**
 * `album-camera-list`, `-add` and `-rm`: an album lists the cameras of its media and the ones added
 * by hand, a camera taken off stays off as more of its media joins, and the list never counts as
 * a member.
 */

import { ALBUMS_ROOT, CAMERAS_ROOT } from '@archive/paths';
import type { AlbumCameraList } from '@archive/media/api';
import type { ContainerListing } from '@ein/client';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

Deno.test({
  name: 'album cameras',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const album = `${ALBUMS_ROOT}/sailing`;
  const camera = `${CAMERAS_ROOT}/camera`;
  const phone = `${CAMERAS_ROOT}/phone`;
  const tracker = `${CAMERAS_ROOT}/tracker`;

  const photo = async (path: string, camera: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', cameraPath: camera } });
  };
  const list = () => client.execJson<AlbumCameraList>(`album-camera-list ${album}`);
  const listed = async () => (await list()).cameras.map(({ path, source, media }) => ({ path, source, media }));

  try {
    for (const root of [CAMERAS_ROOT, ALBUMS_ROOT, '/elsewhere']) await cmd.shouldSucceed(`mkdir -p ${root}`);
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'camera', { attrs: { name: 'Example Camera' } });
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'phone', { attrs: { name: 'Example Phone' } });
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'tracker', { attrs: { name: 'GPS Tracker' } });
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'sailing', { attrs: { name: 'Sailing' } });
    await photo(`${album}/a.jpg`, camera);
    await photo(`${album}/b.jpg`, camera);
    await photo(`${album}/c.jpg`, phone);

    await t.step('the cameras of its media, the most first', async () => {
      assertEquals(await listed(), [
        { path: camera, source: 'media', media: 2 },
        { path: phone, source: 'media', media: 1 },
      ]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a camera added by hand is linked from cameras/ and listed after them', async () => {
      await cmd.shouldSucceed(`album-camera-add ${album} tracker`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${album}/cameras/tracker`, { readlink: true })).props.softlink, tracker);
      assertEquals((await listed()).at(-1), { path: tracker, source: 'added', media: 0 });
      // A camera of its media is on the list already, and gets no link.
      await cmd.shouldSucceed(`album-camera-add ${album} ${camera}`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/cameras/camera`, { follow: false }), false);
    });

    await t.step('the list is not a member', async () => {
      const members = await client.execJson<ContainerListing>(`members ${album}`);
      assertEquals(members.members.length, 3);
    });

    await t.step('a camera of its media taken off stays off as more of its media joins', async () => {
      await cmd.shouldSucceed(`album-camera-rm ${album} ${phone}`);
      await photo(`${album}/d.jpg`, phone);
      assertEquals((await listed()).map((camera) => camera.path), [camera, tracker]);
      assertEquals((await list()).removed.map(({ path, media }) => ({ path, media })), [{ path: phone, media: 2 }]);
      await cmd.shouldSucceed(`album-camera-add ${album} phone`);
      assertEquals((await listed()).map((camera) => camera.path), [camera, phone, tracker]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a camera added by hand and taken off is gone, and the last one takes cameras/ with it', async () => {
      await cmd.shouldSucceed(`album-camera-rm ${album} tracker`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/cameras`, { follow: false }), false);
      assertEquals((await listed()).map((camera) => camera.path), [camera, phone]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a folder that is not an album lists the cameras of its media', async () => {
      await photo('/elsewhere/e.jpg', phone);
      const folder = await client.execJson<AlbumCameraList>('album-camera-list /elsewhere');
      assertEquals(folder.cameras.map(({ path, source, media }) => ({ path, source, media })), [{ path: phone, source: 'media', media: 1 }]);
    });

    await t.step('only an album takes a camera, and only a camera', async () => {
      await cmd.shouldFail(`album-camera-add /elsewhere tracker`);
      await cmd.shouldFail(`album-camera-add ${album} ${album}/a.jpg`);
      await cmd.shouldFail(`album-camera-add ${album} missing`);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
