/**
 * The camera-faces service against a stub EMS and a stub camera driver: a camera's smallest stream
 * given to EMS as a watch at the address its driver names, a face nobody's told on the camera's
 * `faces` log as unknown, a face gone filed as a picture under a camera node made for the device
 * and linked to it, and the watch stopped once the camera is forgotten.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { startStubEms } from '@ems/testing';
import { FACES_ENDPOINT, UNKNOWN_FACE, watchId } from '@archive/media/camera-faces';

/** A JPEG's start and end, which is all the service reads of a crop: it files the bytes it is given. */
const CROP = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9));

const until = async <T>(what: string, read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    try {
      last = await read();
      if (check(last)) return last;
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
};

Deno.test({ name: 'camera-faces', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const ems = startStubEms();
  const testCtx = createTestContext({ modules: ['archive'], boot: true, env: { CFG_EMS_URL: ems.url } });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const devices = testCtx.harness.instance!.devices;
  const unregister = devices.registerDriver('stub-camera', {
    description: 'a camera for the test',
    source: (stream) => Promise.resolve(`rtsp://ein:secret@192.0.2.1:8554/${stream.device}-${stream.endpoint}`),
  });
  const id = watchId('front-door', 'sub');
  try {
    await devices.ensureDevice(ADMIN_ACCESS, 'front-door', { label: 'Front door', driver: 'stub-camera', class: 'camera' });
    await devices.ensureEndpoint(ADMIN_ACCESS, 'front-door', 'main', 'stream', { width: 1920, height: 1080 });
    await devices.ensureEndpoint(ADMIN_ACCESS, 'front-door', 'sub', 'stream', { width: 640, height: 360 });
    await admin.execString('service restart camera-faces');

    await t.step('the smallest stream is watched, at the address its driver names', async () => {
      const spec = await until('the watch', () => Promise.resolve(ems.watches.get(id)), Boolean);
      assertEquals(spec?.source, 'rtsp://ein:secret@192.0.2.1:8554/front-door-sub');
      assertEquals([...ems.watches.keys()], [id]);
    });

    await t.step("a face nobody is told on the camera's faces log as unknown", async () => {
      await until('a follower', () => Promise.resolve(ems.tell(id, { type: 'motion' })), (count) => count > 0);
      ems.tell(id, { type: 'face', track: 1, box: { x: 0.4, y: 0.2, width: 0.1, height: 0.2 }, confidence: 0.9, frame: { width: 640, height: 360 }, embedding: [1, 0, 0] });
      const history = await until(
        'the face on the log',
        () => admin.execJson<{ readings: { value: unknown }[] }>(`device-history front-door/${FACES_ENDPOINT}`),
        (answer) => answer.readings.length > 0,
      );
      assertEquals(history.readings.map((reading) => reading.value), [UNKNOWN_FACE]);
    });

    await t.step('a face gone is filed under a camera node made for the device and linked to it', async () => {
      ems.tell(id, {
        type: 'face.end',
        track: 1,
        box: { x: 0.4, y: 0.2, width: 0.1, height: 0.2 },
        confidence: 0.9,
        frame: { width: 640, height: 360 },
        embedding: [1, 0, 0],
        crop: { type: 'image/jpeg', data: CROP },
        appearances: [[0, 2]],
        detections: 4,
      });
      const faces = await until(
        'the picture',
        () => admin.execJson<{ path: string }[]>('find /archive/cameras/Front_door/faces -name "*.jpg"'),
        (found) => found.length > 0,
      );
      const picture = faces[0].path;
      assert(/\/archive\/cameras\/Front_door\/faces\/\d{4}-\d{2}-\d{2}\/\d{6}-1\.jpg$/.test(picture), picture);
      assertEquals((await admin.execJson<{ attrs: { size: number; mimetype: string } }>(`stat ${picture}`)).attrs.size, 4);
      assertEquals((await admin.execJson<{ softlink: string }>('props -L /archive/cameras/Front_door/device')).softlink, '/dev/front-door');
    });

    await t.step('a camera forgotten is no longer watched', async () => {
      await devices.forget(ADMIN_ACCESS, 'front-door');
      await admin.execString('service restart camera-faces');
      await until('no watch', () => Promise.resolve(ems.watches.size), (size) => size === 0);
    });
  } finally {
    unregister();
    admin.close();
    await testCtx.teardown();
    await ems.close();
  }
});
