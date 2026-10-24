/**
 * promote-exif-attrs: copying facts off the exif node, and the one that needs a gate.
 *
 * `--angle` derives a video's `angle` from the container rotation sitting in the exif node's
 * `raw`, without an exiftool re-run — but only for video.
 *
 * On stills, `raw.Rotation` is a different tag with a different meaning, because `raw` is an
 * *ungrouped* exiftool dump and three tags share that name: `[Panasonic] Rotation` holds EXIF
 * orientation codes (1/6/8/3), `[Canon] Rotation` holds degrees (0/90/270) and
 * `[Composite] Rotation` holds the container matrix in degrees. Reading it for a still would
 * map a Panasonic `6` to 6 degrees. Hence the mimetype gate, and hence this test.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type FileAttrs = { angle?: number; angleManual?: number; width?: number; duration?: number; codec?: string };

Deno.test({
  name: 'promote-exif-attrs',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A file node with an exif child, as `exif-extract` would have left it. */
  const seed = async (name: string, mimetype: string, raw: Record<string, unknown>, fileAttrs = '') => {
    const path = `${ALBUMS_ROOT}/a/files/${name}`;
    await cmd.shouldSucceed(`mkfile ${path}`);
    await cmd.shouldSucceed(`attrs ${path} -s mimetype=${mimetype} ${fileAttrs}`);
    await cmd.shouldSucceed(`mkdir -p ${path}/metadata`);
    await cmd.shouldSucceed(`mknode -t exif ${path}/metadata/exif`);
    await cmd.shouldSucceed(`attrs ${path}/metadata/exif -J raw=${JSON.stringify(JSON.stringify(raw))}`);
    return path;
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a/files`);

    await t.step("a video: the container rotation becomes the node's counter-clockwise angle", async () => {
      const path = await seed('clip.mp4', 'video/mp4', { Rotation: 90, MIMEType: 'video/mp4' });

      await cmd.shouldSucceed(`promote-exif-attrs ${path} --angle`);

      // Rotation is degrees clockwise to display, `angle` is counter-clockwise: complements.
      const attrs = await client.execJson<FileAttrs>(`attrs ${path}`);
      assertEquals(attrs.angle, 270);
    });

    await t.step('a still: Rotation is a maker-note tag and must not be read', async () => {
      // What a Panasonic JPEG actually carries — an orientation code, not degrees. Read as
      // degrees it is not even a quarter turn, so a naive mapping would either store 6 or
      // silently round it away; either way the gate is what keeps it out.
      const panasonic = await seed('P1090014.JPG', 'image/jpeg', { Rotation: 6, Orientation: 6, MIMEType: 'image/jpeg' });
      // And what a Canon JPEG carries: degrees, but describing the same turn the EXIF
      // Orientation beside it already describes. Promoting it would bypass the portrait
      // heuristic `exif-extract` deliberately applies to stills.
      const canon = await seed('IMG_1145.JPG', 'image/jpeg', { Rotation: 90, Orientation: 6, MIMEType: 'image/jpeg' });

      await cmd.shouldSucceed(`promote-exif-attrs ${panasonic} --angle`);
      await cmd.shouldSucceed(`promote-exif-attrs ${canon} --angle`);

      assertEquals((await client.execJson<FileAttrs>(`attrs ${panasonic}`)).angle, undefined);
      assertEquals((await client.execJson<FileAttrs>(`attrs ${canon}`)).angle, undefined);
    });

    await t.step('a manual rotation is never overwritten', async () => {
      const path = await seed('manual.mp4', 'video/mp4', { Rotation: 90, MIMEType: 'video/mp4' }, '-J angle=180 -J angleManual=180');

      await cmd.shouldSucceed(`promote-exif-attrs ${path} --angle`);

      const attrs = await client.execJson<FileAttrs>(`attrs ${path}`);
      assertEquals(attrs.angle, 180);
      assertEquals(attrs.angleManual, 180);
    });

    await t.step('without --angle nothing rotates, and width/height still promote', async () => {
      const path = await seed('plain.mp4', 'video/mp4', { Rotation: 90, MIMEType: 'video/mp4' });
      await cmd.shouldSucceed(`attrs ${path}/metadata/exif -J fileinfo='{"width":1920,"height":1080,"duration":12}'`);

      await cmd.shouldSucceed(`promote-exif-attrs ${path}`);

      const attrs = await client.execJson<FileAttrs>(`attrs ${path}`);
      assertEquals(attrs.angle, undefined);
      assertEquals(attrs.width, 1920);
      assertEquals(attrs.duration, 12);
    });

    await t.step('--codec backfills the picture codec from the stored fourcc', async () => {
      // A file whose fourcc is in `raw` and was never promoted: without it, EMS spends a doomed
      // GPU attempt on it.
      const dv = await seed('tape.avi', 'video/x-msvideo', {
        MIMEType: 'video/x-msvideo',
        VideoCodec: '',
        Compression: 'dvsd',
      });

      await cmd.shouldSucceed(`promote-exif-attrs ${dv} --codec`);

      assertEquals((await client.execJson<FileAttrs>(`attrs ${dv}`)).codec, 'dvvideo');
    });

    await t.step('--codec prefers a codec a newer index already measured', async () => {
      // ffprobe's own decoder name beats mapping the container's fourcc back, so an exif node
      // that has one is believed over `raw`.
      const path = await seed('ps.mpg', 'video/mpeg', { MIMEType: 'video/mpeg' });
      await cmd.shouldSucceed(`attrs ${path}/metadata/exif -J fileinfo='{"codec":"mpeg2video"}'`);

      await cmd.shouldSucceed(`promote-exif-attrs ${path} --codec`);

      assertEquals((await client.execJson<FileAttrs>(`attrs ${path}`)).codec, 'mpeg2video');
    });

    await t.step('a still never gets a codec, and neither does a container without one', async () => {
      // `Compression` on a JPEG is the image compression scheme, not a fourcc — the same
      // ungrouped-dump hazard `Rotation` has.
      const still = await seed('scan.jpg', 'image/jpeg', { MIMEType: 'image/jpeg', Compression: 'JPEG (old-style)' });
      const avchd = await seed('cam.mts', 'video/m2ts', { MIMEType: 'video/m2ts' });

      await cmd.shouldSucceed(`promote-exif-attrs ${still} --codec`);
      await cmd.shouldSucceed(`promote-exif-attrs ${avchd} --codec`);

      assertEquals((await client.execJson<FileAttrs>(`attrs ${still}`)).codec, undefined);
      assertEquals((await client.execJson<FileAttrs>(`attrs ${avchd}`)).codec, undefined);
    });

    await t.step('a rotation that is not a quarter turn is left alone', async () => {
      // 0 is the common one — most containers carry an identity matrix — and an angle of 0
      // written where there was none is a needless write on most of the corpus.
      const upright = await seed('upright.mp4', 'video/mp4', { Rotation: 0, MIMEType: 'video/mp4' });
      const odd = await seed('odd.mp4', 'video/mp4', { Rotation: 45, MIMEType: 'video/mp4' });

      await cmd.shouldSucceed(`promote-exif-attrs ${upright} --angle`);
      await cmd.shouldSucceed(`promote-exif-attrs ${odd} --angle`);

      assertEquals((await client.execJson<FileAttrs>(`attrs ${upright}`)).angle, undefined);
      assertEquals((await client.execJson<FileAttrs>(`attrs ${odd}`)).angle, undefined);
    });
  } finally {
    await testCtx.teardown();
  }
});
