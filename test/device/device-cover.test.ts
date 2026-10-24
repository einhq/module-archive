/**
 * `device-cover`: a device's cover is its newest image. Covers the image-over-video preference,
 * a device with only videos, an undated device, an automatic cover following a newer picture, a
 * chosen cover left alone, a dangling one replaced, `--all`, `--media`, `device-relink` covering
 * the device it linked files to, and which files `media-stills` offers to their device.
 */

import { DEVICES_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';
import type { DeviceCoverSweep } from '@archive/device/api';

const testCtx = createTestContext({ modules: ['archive'] });

/** The condition on `media-stills`' device-cover step. */
const stillsCoverCondition = async (): Promise<string> => {
  const def = parseYaml(await Deno.readTextFile(new URL('../../pipelines/media-stills.yaml', import.meta.url))) as {
    steps: Record<string, { condition?: string }>;
  };
  return def.steps['device-cover'].condition ?? '';
};

Deno.test({
  name: 'device cover',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A media file already linked to `device`, taken at `when` (undated when omitted). */
  const shot = async (path: string, device: string, when?: string, mimetype = 'image/jpeg') => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype, devicePath: device, ...(when ? captureTime(when) : {}) } });
  };

  const coverOf = async (device: string): Promise<{ target?: string; auto?: unknown }> => {
    try {
      const link = await vfs.get<Record<string, unknown>>(ADMIN_ACCESS, `${device}/coverPhoto`, { readlink: true });
      return { target: link.props.softlink, auto: link.attrs.autoCover };
    } catch {
      return {};
    }
  };

  const camera = `${DEVICES_ROOT}/Camera`;
  const scanner = `${DEVICES_ROOT}/Scanner`;
  const phone = `${DEVICES_ROOT}/Phone`;
  const camcorder = `${DEVICES_ROOT}/Camcorder`;

  try {
    await client.exec(`mkdir -p ${DEVICES_ROOT} && mkdir -p /shots`);
    await cmd.shouldSucceed('device-create --name Camera');
    await cmd.shouldSucceed('device-create --name Scanner');
    await cmd.shouldSucceed('device-create --name Phone --serial SER-P');
    await cmd.shouldSucceed('device-create --name Camcorder');

    await shot('/shots/old.jpg', camera, '2010-06-01T10:00:00');
    await shot('/shots/new.jpg', camera, '2012-06-01T10:00:00');
    await shot('/shots/newest.mp4', camera, '2014-06-01T10:00:00', 'video/mp4');
    await shot('/shots/scan.jpg', scanner);

    await t.step('the newest image is the cover, not a newer video', async () => {
      const result = await client.execJson<DeviceCoverSweep>(`device-cover ${camera}`);
      assertEquals(result.devices, [{ path: camera, cover: '/shots/new.jpg' }]);
      assertEquals(await coverOf(camera), { target: '/shots/new.jpg', auto: true });
    });

    await t.step('a device with only videos gets its newest video that has thumbnails', async () => {
      await shot('/shots/clip-old.mp4', camcorder, '2016-06-01T10:00:00', 'video/mp4');
      await shot('/shots/clip-new.mp4', camcorder, '2017-06-01T10:00:00', 'video/mp4');
      await shot('/shots/clip-undated.mp4', camcorder, undefined, 'video/mp4');
      await shot('/shots/hum.m4a', camcorder, '2018-06-01T10:00:00', 'audio/mp4');
      assertEquals((await client.execJson<DeviceCoverSweep>(`device-cover ${camcorder}`)).updated, 0);

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/clip-undated.mp4', 'thumbnails');
      await cmd.shouldSucceed(`device-cover ${camcorder}`);
      assertEquals((await coverOf(camcorder)).target, '/shots/clip-undated.mp4');

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/clip-old.mp4', 'thumbnails');
      await cmd.shouldSucceed(`device-cover ${camcorder}`);
      assertEquals(await coverOf(camcorder), { target: '/shots/clip-old.mp4', auto: true });

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/clip-new.mp4', 'thumbnails');
      await cmd.shouldSucceed(`device-cover ${camcorder}`);
      assertEquals((await coverOf(camcorder)).target, '/shots/clip-new.mp4');
    });

    await t.step('a device whose images have no capture time still gets one', async () => {
      await cmd.shouldSucceed(`device-cover ${scanner}`);
      assertEquals((await coverOf(scanner)).target, '/shots/scan.jpg');
    });

    await t.step('an unchanged automatic cover is not rewritten', async () => {
      const result = await client.execJson<DeviceCoverSweep>(`device-cover ${camera}`);
      assertEquals(result.updated, 0);
    });

    await t.step('an automatic cover follows a newer picture', async () => {
      await shot('/shots/later.jpg', camera, '2013-06-01T10:00:00');
      const result = await client.execJson<DeviceCoverSweep>(`device-cover ${camera}`);
      assertEquals(result.devices, [{ path: camera, cover: '/shots/later.jpg', replaced: '/shots/new.jpg' }]);
    });

    await t.step('a cover somebody chose is kept', async () => {
      await cmd.shouldSucceed(`ln -s -f /shots/old.jpg ${camera}/coverPhoto`);
      const result = await client.execJson<DeviceCoverSweep>(`device-cover ${camera}`);
      assertEquals(result.updated, 0);
      assertEquals((await coverOf(camera)).target, '/shots/old.jpg');
    });

    await t.step('a chosen cover whose picture is gone is replaced', async () => {
      await cmd.shouldSucceed('rm /shots/old.jpg');
      await cmd.shouldSucceed(`device-cover ${camera}`);
      assertEquals(await coverOf(camera), { target: '/shots/later.jpg', auto: true });
    });

    await t.step('--all covers every device that has a picture or a thumbnailed video', async () => {
      await cmd.shouldSucceed(`rm ${camera}/coverPhoto && rm ${scanner}/coverPhoto && rm ${camcorder}/coverPhoto`);
      const result = await client.execJson<DeviceCoverSweep>('device-cover --all');
      assertEquals(result.scanned, 4);
      assertEquals(result.devices.map((one) => one.path).sort(), [camcorder, camera, scanner]);
      assertEquals(await coverOf(phone), {});
    });

    await t.step('device-relink covers the device it linked files to', async () => {
      await cmd.shouldSucceed('echo x > /shots/phone.jpg');
      await vfs.update(ADMIN_ACCESS, '/shots/phone.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('2015-01-01T10:00:00') } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/phone.jpg', 'metadata');
      await vfs.ensure(ADMIN_ACCESS, 'exif', '/shots/phone.jpg/metadata', 'exif');
      await vfs.update(ADMIN_ACCESS, '/shots/phone.jpg/metadata/exif', { attrs: { indexedAt: '2020-01-01T00:00:00Z', deviceSerialNumber: 'SER-P' } });

      await cmd.shouldSucceed(`device-relink ${phone}`);
      assertEquals((await coverOf(phone)).target, '/shots/phone.jpg');
    });

    await t.step('--media covers the device each file is linked to, once', async () => {
      await cmd.shouldSucceed(`rm ${camcorder}/coverPhoto`);
      await cmd.shouldSucceed('echo x > /shots/loose.mp4');
      const result = await client.execJson<DeviceCoverSweep>('device-cover --media /shots/clip-old.mp4 /shots/clip-new.mp4 /shots/loose.mp4');
      assertEquals(result.scanned, 1);
      assertEquals(result.devices, [{ path: camcorder, cover: '/shots/clip-new.mp4' }]);
    });

    await t.step('media-stills offers a video to its device, and nothing else', async () => {
      const condition = await stillsCoverCondition();
      const holds = (mimetype: string, deviceKey: string) => client.exec(`(\nexport EVENT_MIMETYPE=${mimetype}\nexport EVENT_DEVICE_KEY=${deviceKey}\n${condition}\n)`);
      assertEquals((await holds('video/mp4', 'HDR-1')).success, true);
      assertEquals((await holds('video/mp4', "''")).success, false);
      assertEquals((await holds('image/jpeg', 'HDR-1')).success, false);
    });

    await t.step('a path or --all is required, and only a device is covered', async () => {
      await cmd.shouldFail('device-cover');
      await cmd.shouldFail(`device-cover --all ${camera}`);
      await cmd.shouldFail('device-cover /shots/new.jpg');
    });
  } finally {
    client.close();
  }
});
