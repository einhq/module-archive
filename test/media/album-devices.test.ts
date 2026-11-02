/**
 * `album-device-list`, `-add` and `-rm`: an album lists the devices of its media and the ones added
 * by hand, a device taken off stays off as more of its media joins, and the list never counts as
 * a member.
 */

import { ALBUMS_ROOT, DEVICES_ROOT } from '@archive/paths';
import type { AlbumDeviceList } from '@archive/media/api';
import type { ContainerListing } from '@ein/client';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

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
  const camera = `${DEVICES_ROOT}/camera`;
  const phone = `${DEVICES_ROOT}/phone`;
  const tracker = `${DEVICES_ROOT}/tracker`;

  const photo = async (path: string, device: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', devicePath: device } });
  };
  const list = () => client.execJson<AlbumDeviceList>(`album-device-list ${album}`);
  const listed = async () => (await list()).devices.map(({ path, source, media }) => ({ path, source, media }));

  try {
    for (const root of [DEVICES_ROOT, ALBUMS_ROOT, '/elsewhere']) await cmd.shouldSucceed(`mkdir -p ${root}`);
    await vfs.create(ADMIN_ACCESS, 'device', DEVICES_ROOT, 'camera', { attrs: { name: 'Example Camera' } });
    await vfs.create(ADMIN_ACCESS, 'device', DEVICES_ROOT, 'phone', { attrs: { name: 'Example Phone' } });
    await vfs.create(ADMIN_ACCESS, 'device', DEVICES_ROOT, 'tracker', { attrs: { name: 'GPS Tracker' } });
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'sailing', { attrs: { name: 'Sailing' } });
    await photo(`${album}/a.jpg`, camera);
    await photo(`${album}/b.jpg`, camera);
    await photo(`${album}/c.jpg`, phone);

    await t.step('the devices of its media, the most first', async () => {
      assertEquals(await listed(), [
        { path: camera, source: 'media', media: 2 },
        { path: phone, source: 'media', media: 1 },
      ]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a device added by hand is linked from devices/ and listed after them', async () => {
      await cmd.shouldSucceed(`album-device-add ${album} tracker`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${album}/devices/tracker`, { readlink: true })).props.softlink, tracker);
      assertEquals((await listed()).at(-1), { path: tracker, source: 'added', media: 0 });
      // A device of its media is on the list already, and gets no link.
      await cmd.shouldSucceed(`album-device-add ${album} ${camera}`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/devices/camera`, { follow: false }), false);
    });

    await t.step('the list is not a member', async () => {
      const members = await client.execJson<ContainerListing>(`members ${album}`);
      assertEquals(members.members.length, 3);
    });

    await t.step('a device of its media taken off stays off as more of its media joins', async () => {
      await cmd.shouldSucceed(`album-device-rm ${album} ${phone}`);
      await photo(`${album}/d.jpg`, phone);
      assertEquals((await listed()).map((device) => device.path), [camera, tracker]);
      assertEquals((await list()).removed.map(({ path, media }) => ({ path, media })), [{ path: phone, media: 2 }]);
      await cmd.shouldSucceed(`album-device-add ${album} phone`);
      assertEquals((await listed()).map((device) => device.path), [camera, phone, tracker]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a device added by hand and taken off is gone, and the last one takes devices/ with it', async () => {
      await cmd.shouldSucceed(`album-device-rm ${album} tracker`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/devices`, { follow: false }), false);
      assertEquals((await listed()).map((device) => device.path), [camera, phone]);
      assertEquals((await list()).removed, []);
    });

    await t.step('a folder that is not an album lists the devices of its media', async () => {
      await photo('/elsewhere/e.jpg', phone);
      const folder = await client.execJson<AlbumDeviceList>('album-device-list /elsewhere');
      assertEquals(folder.devices.map(({ path, source, media }) => ({ path, source, media })), [{ path: phone, source: 'media', media: 1 }]);
    });

    await t.step('only an album takes a device, and only a device', async () => {
      await cmd.shouldFail(`album-device-add /elsewhere tracker`);
      await cmd.shouldFail(`album-device-add ${album} ${album}/a.jpg`);
      await cmd.shouldFail(`album-device-add ${album} missing`);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
