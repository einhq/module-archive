/**
 * file-set-orientation: turning a file must move its face boxes with it.
 *
 * The invariant worth pinning is that the raw frame never changes — the pixels do not move,
 * only the frame the box is described in. Four quarter turns, or two mirrors, must therefore
 * put every box back exactly where it started. `--no-regenerate` keeps this in the fast tier:
 * the geometry is the part that can be wrong, and ImageMagick is not in it.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertAlmostEquals, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext, testCommands } from '@ein/testing';
import { boxDisplayToRaw } from '../../lib/media/orientation.ts';

const testCtx = createTestContext({ modules: ['archive'] });

type Box = { x: number; y: number; width: number; height: number };

const START: Box = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };

const assertBox = (actual: Box, expected: Box, msg: string) => {
  assertAlmostEquals(actual.x, expected.x, 1e-5, `${msg} (x)`);
  assertAlmostEquals(actual.y, expected.y, 1e-5, `${msg} (y)`);
  assertAlmostEquals(actual.width, expected.width, 1e-5, `${msg} (width)`);
  assertAlmostEquals(actual.height, expected.height, 1e-5, `${msg} (height)`);
};

Deno.test({
  name: 'file-set-orientation',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const IMAGE = `${ALBUMS_ROOT}/a/files/p.jpg`;
  const FACE = `${IMAGE}/regions/face-0`;

  const fileAttrs = () => vfs.get<{ angle?: number; angleManual?: number; mirror?: boolean }>(ADMIN_ACCESS, IMAGE).then((n) => n.attrs);
  const faceAttrs = () =>
    vfs.get<{ faceBox: Box; landmarks?: [number, number][]; pose?: { pitch: number; yaw: number; roll: number } }>(ADMIN_ACCESS, FACE).then((n) => n.attrs);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a/files`);
    await client.exec(`mkfile ${IMAGE}`);
    await vfs.update(ADMIN_ACCESS, IMAGE, { attrs: { mimetype: 'image/jpeg', width: 400, height: 200 } });
    await client.exec(`mkdir -p ${IMAGE}/regions`);

    const fileId = (await vfs.get(ADMIN_ACCESS, IMAGE)).id;
    await client.exec(`mknode -t media-region ${FACE} --as fileId=${fileId} --an confidence=0.9`);
    await vfs.update(ADMIN_ACCESS, FACE, { attrs: { faceBox: START, landmarks: [[0.15, 0.25], [0.35, 0.4]] } });

    await t.step('a quarter turn writes both angle and angleManual', async () => {
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --rotate cw --no-regenerate`);
      const attrs = await fileAttrs();
      // Clockwise on screen is a *decrease* of the stored counter-clockwise angle.
      assertEquals(attrs.angle, 270);
      // Both, or exif-extract reverts it on the next crawl (angle) or the renditions ignore
      // it (angleManual alone is never read by generate-derivatives).
      assertEquals(attrs.angleManual, 270);
    });

    await t.step('the box moved, but describes the same raw pixels', async () => {
      const moved = (await faceAttrs()).faceBox;
      // It really did move — otherwise the next assertion would pass trivially.
      assertEquals(moved.x === START.x && moved.y === START.y, false);
      assertBox(boxDisplayToRaw(moved, 270, false), boxDisplayToRaw(START, 0, false), 'raw frame');
    });

    await t.step('four quarter turns are the identity', async () => {
      for (let i = 0; i < 3; i++) await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --rotate cw --no-regenerate`);
      assertEquals((await fileAttrs()).angle, 0);
      assertBox((await faceAttrs()).faceBox, START, 'after a full turn');
    });

    await t.step('landmarks travel with the box', async () => {
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --rotate ccw --no-regenerate`);
      const turned = await faceAttrs();
      assertEquals(turned.landmarks?.length, 2);
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --rotate cw --no-regenerate`);
      const back = await faceAttrs();
      assertAlmostEquals(back.landmarks![0][0], 0.15, 1e-5);
      assertAlmostEquals(back.landmarks![0][1], 0.25, 1e-5);
    });

    await t.step('the head pose turns with the frame', async () => {
      await vfs.update(ADMIN_ACCESS, FACE, { attrs: { pose: { pitch: -5, yaw: 20, roll: 10 } } });
      // A picture turned clockwise on screen turns every head in it clockwise too: roll is
      // measured clockwise, so it grows by a quarter turn. Pitch and yaw are the head's own.
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --rotate cw --no-regenerate`);
      assertEquals((await faceAttrs()).pose, { pitch: -5, yaw: 20, roll: 100 });
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --rotate ccw --no-regenerate`);
      assertEquals((await faceAttrs()).pose, { pitch: -5, yaw: 20, roll: 10 });
      // A mirror turns a left turn into a right one and a tilt the other way.
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --toggle-mirror --no-regenerate`);
      assertEquals((await faceAttrs()).pose, { pitch: -5, yaw: -20, roll: -10 });
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --toggle-mirror --no-regenerate`);
      assertEquals((await faceAttrs()).pose, { pitch: -5, yaw: 20, roll: 10 });
    });

    await t.step('mirror toggles, and toggling twice is the identity', async () => {
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --toggle-mirror --no-regenerate`);
      assertEquals((await fileAttrs()).mirror, true);
      const flipped = (await faceAttrs()).faceBox;
      assertAlmostEquals(flipped.x, 1 - (START.x + START.width), 1e-5);

      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --toggle-mirror --no-regenerate`);
      assertEquals((await fileAttrs()).mirror, false);
      assertBox((await faceAttrs()).faceBox, START, 'after two mirrors');
    });

    await t.step('an absolute angle is accepted, a nonsense one is not', async () => {
      await cmd.shouldSucceed(`file-set-orientation ${IMAGE} --angle 180 --no-regenerate`);
      assertEquals((await fileAttrs()).angle, 180);
      await cmd.shouldFail(`file-set-orientation ${IMAGE} --angle 45 --no-regenerate`);
      await cmd.shouldFail(`file-set-orientation ${IMAGE} --rotate sideways --no-regenerate`);
      // The failed calls changed nothing.
      assertEquals((await fileAttrs()).angle, 180);
    });

    await t.step('a no-op turn leaves the boxes alone', async () => {
      const before = (await faceAttrs()).faceBox;
      const result = await client.execJson<{ changed: boolean; facesRemapped: number }>(`file-set-orientation ${IMAGE} --angle 180 --no-regenerate`);
      assertEquals(result.changed, false);
      assertEquals(result.facesRemapped, 0);
      assertBox((await faceAttrs()).faceBox, before, 'unchanged');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
