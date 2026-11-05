/**
 * `regenerate-face-crops --missing`: the repair of the crops an interrupted write left as a 0-byte
 * node, or never created, from the stored box. These assertions are about which crops a run picks
 * up and which it leaves alone — the cut itself needs EMS and is asserted in the container tier.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Summary = { scanned: number; candidates: number; regenerated: number; skippedPresent: number; skippedInvalid: number; failed: number };

Deno.test({
  name: 'regenerate-face-crops --missing cuts the crops a write left empty or never made',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  /** The repair over one picture's faces. */
  const repair = (image: string) => client.execJson<Summary>(`JSON_OUTPUT=1 regenerate-face-crops --missing --file ${image}`);

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

      const summary = await repair(image);
      assertEquals([summary.candidates, summary.skippedPresent, summary.failed], [0, 1, 0]);
    });

    await t.step('an image with no faces is not an error', async () => {
      const image = await makeImage('nobody.jpg', 0);

      const summary = await repair(image);
      assertEquals([summary.scanned, summary.failed], [0, 0]);
    });

    /**
     * The case the repair exists for. The cut needs EMS, which this tier does not have, so the
     * run is expected to fail — and it fails *naming the crop*, which is the assertion.
     */
    await t.step('a crop with no bytes is picked up for a rebuild', async () => {
      const image = await makeImage('interrupted.jpg', 1);
      const cropPath = `${image}/regions/face-0/image.avif`;

      const result = await client.exec(`regenerate-face-crops --missing --file ${image}`);
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

      await client.exec(`regenerate-face-crops --missing --file ${image}`);

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

      const summary = await repair(image);
      assertEquals([summary.candidates, summary.skippedInvalid, summary.failed], [0, 1, 0]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
