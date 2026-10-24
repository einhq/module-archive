/**
 * Face crops as a target of `generate-derivatives`.
 *
 * A `regenerate` sweep reaches the crops: an interrupted write leaves a 0-byte node, and the
 * repair sweep rebuilds it from the stored box. These assertions are about which
 * crops a run picks up and which it leaves alone — the cut itself needs ImageMagick and is
 * asserted in the container tier.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Report = { created: string[]; pruned: string[]; failed: number };

Deno.test({
  name: 'generate-derivatives targets face crops',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** An image node with `count` faces, each with a stored box and a crop node. */
  const makeImage = async (name: string, count: number): Promise<string> => {
    const image = `${ALBUMS_ROOT}/a/${name}`;
    await client.exec(`mkfile ${image}`);
    await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg', width: 1200, height: 800 } });
    const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;

    for (let i = 0; i < count; i++) {
      const facePath = `${image}/regions/face-${i}`;
      await client.exec(`mknode -p -t media-region ${facePath} --as fileId=${fileId}`);
      await vfs.update(ADMIN_ACCESS, facePath, { attrs: { faceBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } });
      await client.exec(`mknode -p -t file ${facePath}/image.avif --as mimetype=image/avif --as sourceId=${fileId}`);
    }
    return image;
  };

  /** Give a crop node bytes, the way `file-sync` does after a successful cut. */
  const fillCrop = async (cropPath: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, cropPath, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode('avif-bytes'));
    } finally {
      await handle.close();
    }
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a`);

    await t.step('a crop that has bytes is left alone', async () => {
      const image = await makeImage('kept.jpg', 1);
      await fillCrop(`${image}/regions/face-0/image.avif`);

      const report = await client.execJson<Report>(`JSON_OUTPUT=1 generate-derivatives ${image} --size face`);
      assertEquals(report.created, []);
      assertEquals(report.failed, 0);
    });

    await t.step('an image with no faces is not an error', async () => {
      const image = await makeImage('nobody.jpg', 0);

      const report = await client.execJson<Report>(`JSON_OUTPUT=1 generate-derivatives ${image} --size face`);
      assertEquals(report.created, []);
      assertEquals(report.failed, 0);
    });

    /**
     * The case the whole entry exists for. The cut needs ImageMagick, which this tier does not
     * have, so the run is expected to fail — and it fails *naming the crop*, which is the
     * assertion.
     */
    await t.step('a crop with no bytes is picked up for a rebuild', async () => {
      const image = await makeImage('interrupted.jpg', 1);
      const cropPath = `${image}/regions/face-0/image.avif`;

      const result = await client.exec(`generate-derivatives ${image} --size face`);
      assertEquals(result.success, false);
      assertEquals(result.error?.includes(cropPath), true, `no attempt on ${cropPath}: ${result.error}`);
    });

    /**
     * A crop node the interruption never got as far as creating. The same repair covers it —
     * the box is the input, and it is already stored on the face node.
     */
    await t.step('a face with no crop node at all gets one', async () => {
      const image = await makeImage('no-crop.jpg', 0);
      const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
      const facePath = `${image}/regions/face-0`;
      await client.exec(`mknode -p -t media-region ${facePath} --as fileId=${fileId}`);
      await vfs.update(ADMIN_ACCESS, facePath, { attrs: { faceBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } });

      await client.exec(`generate-derivatives ${image} --size face`);

      const crop = await vfs.get<{ mimetype?: string; sourceId?: string }>(ADMIN_ACCESS, `${facePath}/image.avif`);
      assertEquals(crop.attrs.mimetype, 'image/avif');
      assertEquals(crop.attrs.sourceId, fileId);
    });

    await t.step('a face with no stored box is skipped, not failed', async () => {
      const image = await makeImage('boxless.jpg', 0);
      const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
      await client.exec(
        `mknode -p -t media-region ${image}/regions/face-0 --as fileId=${fileId}`,
      );

      const report = await client.execJson<Report>(`JSON_OUTPUT=1 generate-derivatives ${image} --size face`);
      assertEquals(report.created, []);
      assertEquals(report.failed, 0);
    });

    /** `--only transcode` is the video pool's call; a crop is preview-class work. */
    await t.step('the transcode class does not touch face crops', async () => {
      const image = await makeImage('classed.jpg', 1);

      const report = await client.execJson<Report>(`JSON_OUTPUT=1 generate-derivatives ${image} --only transcode`);
      assertEquals(report.created, []);
      assertEquals(report.failed, 0);
    });

    await cmd.shouldFailWith(`generate-derivatives ${ALBUMS_ROOT}/a/kept.jpg --size faces`, 'unknown size');
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
