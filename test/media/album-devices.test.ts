/**
 * `album-device-list`, `-add` and `-rm`: an album lists the devices the cameras of its media are
 * linked to and the ones added by hand, each with the tracks its map draws, a device taken off
 * stays off as more of its media joins, and the list never counts as a member.
 */

import { ALBUMS_ROOT, CAMERAS_ROOT } from '@archive/paths';
import type { AlbumDeviceList } from '@archive/media/api';
import type { ContainerListing } from '@ein/client';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { deviceAt, mkTracker, positionOf } from '../location/tracker.ts';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

Deno.test({
  name: 'album devices',
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
  const boat = deviceAt('sailboat');
  const pocket = deviceAt('anna-phone');
  const hiking = deviceAt('hiking-gps');

  const photo = async (path: string, camera: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', cameraPath: camera } });
  };
  const list = () => client.execJson<AlbumDeviceList>(`album-device-list ${album}`);
  const listed = async () => (await list()).devices.map(({ path, source, media }) => ({ path, source, media }));

  try {
    for (const root of [CAMERAS_ROOT, ALBUMS_ROOT, '/elsewhere']) await cmd.shouldSucceed(`mkdir -p ${root}`);
    await cmd.shouldSucceed(mkTracker('sailboat', 'Sailboat'));
    await cmd.shouldSucceed(mkTracker('anna-phone', 'Anna Andersson'));
    await cmd.shouldSucceed(mkTracker('hiking-gps', 'Hiking GPS'));
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'camera', { attrs: { name: 'Example Camera' } });
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'phone', { attrs: { name: 'Example Phone' } });
    await vfs.create(ADMIN_ACCESS, 'camera', CAMERAS_ROOT, 'scanner', { attrs: { name: 'Example Scanner' } });
    await cmd.shouldSucceed(`camera-device camera ${boat} && camera-device phone anna-phone`);
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'sailing', { attrs: { name: 'Sailing' } });
    await photo(`${album}/a.jpg`, camera);
    await photo(`${album}/b.jpg`, camera);
    await photo(`${album}/c.jpg`, phone);
    // A camera that is part of no device adds none.
    await photo(`${album}/s.jpg`, scanner);

    await t.step('the devices the cameras of its media are linked to, the most media first, with their tracks', async () => {
      assertEquals(await listed(), [
        { path: boat, source: 'media', media: 2 },
        { path: pocket, source: 'media', media: 1 },
      ]);
      assertEquals((await list()).devices.map((device) => [device.name, device.tracks]), [
        ['Sailboat', [positionOf('sailboat')]],
        ['Anna Andersson', [positionOf('anna-phone')]],
      ]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a device added by hand is linked from devices/ and listed after them', async () => {
      await cmd.shouldSucceed(`album-device-add ${album} hiking-gps`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${album}/devices/hiking-gps`, { readlink: true })).props.softlink, hiking);
      assertEquals((await listed()).at(-1), { path: hiking, source: 'added', media: 0 });
      // A device of its media is on the list already, and gets no link; a track names its device.
      await cmd.shouldSucceed(`album-device-add ${album} ${positionOf('sailboat')}`);
      assertEquals((await vfs.children(ADMIN_ACCESS, `${album}/devices`, { follow: false })).map((entry) => entry.name), ['hiking-gps']);
    });

    await t.step('the list is not a member', async () => {
      const members = await client.execJson<ContainerListing>(`members ${album}`);
      assertEquals(members.members.length, 4);
    });

    await t.step('a device of its media taken off stays off as more of its media joins', async () => {
      await cmd.shouldSucceed(`album-device-rm ${album} ${pocket}`);
      await photo(`${album}/d.jpg`, phone);
      assertEquals((await listed()).map((device) => device.path), [boat, hiking]);
      assertEquals((await list()).removed.map(({ path, media }) => ({ path, media })), [{ path: pocket, media: 2 }]);
      await cmd.shouldSucceed(`album-device-add ${album} anna-phone`);
      // Two pictures each: the names decide.
      assertEquals((await listed()).map((device) => device.path), [pocket, boat, hiking]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a device added by hand and taken off is gone, and the last one takes devices/ with it', async () => {
      await cmd.shouldSucceed(`album-device-rm ${album} hiking-gps`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/devices`, { follow: false }), false);
      assertEquals((await listed()).map((device) => device.path), [pocket, boat]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a folder that is not an album lists the devices of its media', async () => {
      await photo('/elsewhere/e.jpg', phone);
      const folder = await client.execJson<AlbumDeviceList>('album-device-list /elsewhere');
      assertEquals(folder.devices.map(({ path, source, media }) => ({ path, source, media })), [{ path: pocket, source: 'media', media: 1 }]);
    });

    await t.step('only an album takes a device, and only a device', async () => {
      await cmd.shouldFailWith(`album-device-add /elsewhere hiking-gps`, 'not an album');
      await cmd.shouldFailWith(`album-device-add ${album} ${album}/a.jpg`, 'not a device');
      await cmd.shouldFailWith(`album-device-add ${album} missing`, 'no such device');
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
