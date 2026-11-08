/**
 * `camera-cover`: a camera's cover is its newest image. Covers the image-over-video preference,
 * a camera with only videos, an undated camera, an automatic cover following a newer picture, a
 * chosen cover left alone, a dangling one replaced, `--all`, `--media`, `camera-relink` covering
 * the camera it linked files to, and which files `media-camera-cover` offers to their camera.
 */

import { CAMERAS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';
import type { CameraCoverSweep } from '@archive/camera/api';

const testCtx = createTestContext({ modules: ['archive'] });

/** `media-camera-cover`'s trigger and steps. */
const coverPipeline = async () =>
  parseYaml(await Deno.readTextFile(new URL('../../pipelines/media-camera-cover.yaml', import.meta.url))) as {
    trigger: { on: string; match?: Record<string, unknown> };
    steps: Record<string, { command: string; condition?: string }>;
  };

Deno.test({
  name: 'camera cover',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A media file already linked to `camera`, taken at `when` (undated when omitted). */
  const shot = async (path: string, camera: string, when?: string, mimetype = 'image/jpeg') => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype, cameraPath: camera, ...(when ? captureTime(when) : {}) } });
  };

  const coverOf = async (camera: string): Promise<{ target?: string; auto?: unknown }> => {
    try {
      const link = await vfs.get<Record<string, unknown>>(ADMIN_ACCESS, `${camera}/coverPhoto`, { readlink: true });
      return { target: link.props.softlink, auto: link.attrs.autoCover };
    } catch {
      return {};
    }
  };

  const camera = `${CAMERAS_ROOT}/Camera`;
  const scanner = `${CAMERAS_ROOT}/Scanner`;
  const phone = `${CAMERAS_ROOT}/Phone`;
  const camcorder = `${CAMERAS_ROOT}/Camcorder`;

  try {
    await client.exec(`mkdir -p ${CAMERAS_ROOT} && mkdir -p /shots`);
    await cmd.shouldSucceed('camera-create --name Camera');
    await cmd.shouldSucceed('camera-create --name Scanner');
    await cmd.shouldSucceed('camera-create --name Phone --serial SER-P');
    await cmd.shouldSucceed('camera-create --name Camcorder');

    await shot('/shots/old.jpg', camera, '2010-06-01T10:00:00');
    await shot('/shots/new.jpg', camera, '2012-06-01T10:00:00');
    await shot('/shots/newest.mp4', camera, '2014-06-01T10:00:00', 'video/mp4');
    await shot('/shots/scan.jpg', scanner);

    await t.step('the newest image is the cover, not a newer video', async () => {
      const result = await client.execJson<CameraCoverSweep>(`camera-cover ${camera}`);
      assertEquals(result.cameras, [{ path: camera, cover: '/shots/new.jpg' }]);
      assertEquals(await coverOf(camera), { target: '/shots/new.jpg', auto: true });
    });

    await t.step('a camera with only videos gets its newest video that has thumbnails', async () => {
      await shot('/shots/clip-old.mp4', camcorder, '2016-06-01T10:00:00', 'video/mp4');
      await shot('/shots/clip-new.mp4', camcorder, '2017-06-01T10:00:00', 'video/mp4');
      await shot('/shots/clip-undated.mp4', camcorder, undefined, 'video/mp4');
      await shot('/shots/hum.m4a', camcorder, '2018-06-01T10:00:00', 'audio/mp4');
      assertEquals((await client.execJson<CameraCoverSweep>(`camera-cover ${camcorder}`)).updated, 0);

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/clip-undated.mp4', 'thumbnails');
      await cmd.shouldSucceed(`camera-cover ${camcorder}`);
      assertEquals((await coverOf(camcorder)).target, '/shots/clip-undated.mp4');

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/clip-old.mp4', 'thumbnails');
      await cmd.shouldSucceed(`camera-cover ${camcorder}`);
      assertEquals(await coverOf(camcorder), { target: '/shots/clip-old.mp4', auto: true });

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/clip-new.mp4', 'thumbnails');
      await cmd.shouldSucceed(`camera-cover ${camcorder}`);
      assertEquals((await coverOf(camcorder)).target, '/shots/clip-new.mp4');
    });

    await t.step('a camera whose images have no capture time still gets one', async () => {
      await cmd.shouldSucceed(`camera-cover ${scanner}`);
      assertEquals((await coverOf(scanner)).target, '/shots/scan.jpg');
    });

    await t.step('an unchanged automatic cover is not rewritten', async () => {
      const result = await client.execJson<CameraCoverSweep>(`camera-cover ${camera}`);
      assertEquals(result.updated, 0);
    });

    await t.step('an automatic cover follows a newer picture', async () => {
      await shot('/shots/later.jpg', camera, '2013-06-01T10:00:00');
      const result = await client.execJson<CameraCoverSweep>(`camera-cover ${camera}`);
      assertEquals(result.cameras, [{ path: camera, cover: '/shots/later.jpg', replaced: '/shots/new.jpg' }]);
    });

    await t.step('a cover somebody chose is kept', async () => {
      await cmd.shouldSucceed(`ln -s -f /shots/old.jpg ${camera}/coverPhoto`);
      const result = await client.execJson<CameraCoverSweep>(`camera-cover ${camera}`);
      assertEquals(result.updated, 0);
      assertEquals((await coverOf(camera)).target, '/shots/old.jpg');
    });

    await t.step('a chosen cover whose picture is gone is replaced', async () => {
      await cmd.shouldSucceed('rm /shots/old.jpg');
      await cmd.shouldSucceed(`camera-cover ${camera}`);
      assertEquals(await coverOf(camera), { target: '/shots/later.jpg', auto: true });
    });

    await t.step('--all covers every camera that has a picture or a thumbnailed video', async () => {
      await cmd.shouldSucceed(`rm ${camera}/coverPhoto && rm ${scanner}/coverPhoto && rm ${camcorder}/coverPhoto`);
      const result = await client.execJson<CameraCoverSweep>('camera-cover --all');
      assertEquals(result.scanned, 4);
      assertEquals(result.cameras.map((one) => one.path).sort(), [camcorder, camera, scanner]);
      assertEquals(await coverOf(phone), {});
    });

    await t.step('camera-relink covers the camera it linked files to', async () => {
      await cmd.shouldSucceed('echo x > /shots/phone.jpg');
      await vfs.update(ADMIN_ACCESS, '/shots/phone.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('2015-01-01T10:00:00') } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/phone.jpg', 'metadata');
      await vfs.ensure(ADMIN_ACCESS, 'exif', '/shots/phone.jpg/metadata', 'exif');
      await vfs.update(ADMIN_ACCESS, '/shots/phone.jpg/metadata/exif', { attrs: { indexedAt: '2020-01-01T00:00:00Z', deviceSerialNumber: 'SER-P' } });

      await cmd.shouldSucceed(`camera-relink ${phone}`);
      assertEquals((await coverOf(phone)).target, '/shots/phone.jpg');
    });

    await t.step('--media covers the camera each file is linked to, once', async () => {
      await cmd.shouldSucceed(`rm ${camcorder}/coverPhoto`);
      await cmd.shouldSucceed('echo x > /shots/loose.mp4');
      const result = await client.execJson<CameraCoverSweep>('camera-cover --media /shots/clip-old.mp4 /shots/clip-new.mp4 /shots/loose.mp4');
      assertEquals(result.scanned, 1);
      assertEquals(result.cameras, [{ path: camcorder, cover: '/shots/clip-new.mp4' }]);
    });

    await t.step('a video is offered to its camera once its renditions are made, and nothing else', async () => {
      const def = await coverPipeline();
      assertEquals(def.trigger.on, 'media.renditions.made');
      assertEquals(def.trigger.match, { mimetype: 'video/*' });
      assertEquals(Object.values(def.steps).map((step) => [step.command, step.condition]), [['camera-cover --media $NODE_PATH', undefined]]);
    });

    await t.step('a path or --all is required, and only a camera is covered', async () => {
      await cmd.shouldFail('camera-cover');
      await cmd.shouldFail(`camera-cover --all ${camera}`);
      await cmd.shouldFail('camera-cover /shots/new.jpg');
    });
  } finally {
    client.close();
  }
});
