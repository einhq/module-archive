/**
 * Container tier: the orientation facts EiN's own rules rest on, checked against the real
 * tools — through EMS, where the tools live — rather than against our belief about them.
 *
 * What ImageMagick and the model readers do with a HEIF `irot`, where a display-frame crop
 * lands on a rotated raster, and that a fraction cuts the same face out of a raster decoded at
 * another scale are EMS's promises, pinned in its own suite. What is left here is EiN's half:
 *
 * 1. Where a video's pixel shape can be read from. exiftool answers for one container family
 *    and says nothing at all for another, which is why `sar` is measured with a probe and stored
 *    relative to whichever raster the dump named — `resolveMediaFacts` over `media.probe`'s
 *    raw dumps, exactly as `exif-extract` runs it.
 * 2. That a poster frame comes out in the same picture shape, so the stored `sar` and the
 *    tile agree and the grid does not reflow when the tile finally decodes.
 * 3. That a display-frame crop of a rotated source has the display frame's geometry once
 *    EiN's `angle` (the one `exif-extract` derives from the tag) is the only turn stated.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { poster, probe, renditions } from '@ems/client';
import { faceCropTarget, MAX_CROP_DIMENSION } from '@archive/media/face-crop';
import { resolveMediaFacts } from '@archive/media/media-probe';
import { pictureDims, sarFromExifRaw } from '@archive/media/orientation';
import { containerTest } from '@ein/testing';
import { ANAMORPHIC, emsCommand, ROTATED, stageMediaFixtures } from './media-fixtures.ts';

containerTest('orientation E2E', async (t) => {
  const fixtures = await stageMediaFixtures();
  const cmd = emsCommand();

  try {
    await t.step("a video's pixel shape: what each container tells exiftool, and what it does not", async () => {
      // The two fixtures are the same picture — 480x360 coded, SAR 4:3, a 640x360 picture — in
      // two containers, and exiftool describes them completely differently.
      const mp4 = await probe(cmd, fixtures.anamorphicMp4);
      const m2ts = await probe(cmd, fixtures.anamorphicM2ts);
      const mp4Raw = mp4.raw.exiftool!;
      const m2tsRaw = m2ts.raw.exiftool!;

      // MP4: the track header carries the ratio, so exiftool applies it and `ImageWidth` is
      // already the picture. `sar` is 1 and no probe is owed.
      assertEquals([mp4Raw.ImageWidth, mp4Raw.ImageHeight], [ANAMORPHIC.displayWidth, ANAMORPHIC.displayHeight]);
      assertEquals([mp4Raw.SourceImageWidth, mp4Raw.SourceImageHeight], [ANAMORPHIC.width, ANAMORPHIC.height]);
      assertEquals(sarFromExifRaw(mp4Raw, mp4Raw.ImageWidth as number, mp4Raw.ImageHeight as number), 1);

      // MPEG-TS: the H.264 sequence header gives dimensions and nothing else, so the dump names
      // the *coded* raster and carries no ratio under any key: the `.MTS` case.
      assertEquals([m2tsRaw.ImageWidth, m2tsRaw.ImageHeight], [ANAMORPHIC.width, ANAMORPHIC.height]);
      assertEquals(Object.keys(m2tsRaw).filter((key) => /aspect/i.test(key)), []);
      assertEquals(sarFromExifRaw(m2tsRaw, m2tsRaw.ImageWidth as number, m2tsRaw.ImageHeight as number), undefined);

      // So the probe answers instead, reduced against the raster the node would store — and the
      // picture that comes back out of `pictureDims` is the one ffmpeg itself renders. The dump
      // is what `media.probe` attaches under `raw.ffprobe`.
      const facts = resolveMediaFacts(
        { ffprobe: m2ts.raw.ffprobe },
        String(m2tsRaw.MIMEType),
        Number(m2tsRaw.Duration),
        { width: ANAMORPHIC.width, height: ANAMORPHIC.height },
      );
      assertAlmostEquals(facts.sar!, 4 / 3, 1e-6);
      assertEquals(pictureDims(ANAMORPHIC.width, ANAMORPHIC.height, 0, facts.sar), {
        width: ANAMORPHIC.displayWidth,
        height: ANAMORPHIC.displayHeight,
      });
    });

    await t.step('a poster frame is the picture, not the raster', async () => {
      // The same shape a still extracted from it comes out at: EMS squares the pixels before it
      // fits the frame, so the stored `sar` and the poster agree.
      // At 0: the fixture is one second long, and EMS's default of a second in is past its end.
      const made = await poster(cmd, fixtures.anamorphicM2ts, {
        at: 0,
        targets: [{ output: `${fixtures.dir}/anamorphic-poster.png`, format: 'png' }],
      });
      assertEquals(made.frame, { width: ANAMORPHIC.displayWidth, height: ANAMORPHIC.displayHeight });
      assertEquals([made.targets[0].width, made.targets[0].height], [ANAMORPHIC.displayWidth, ANAMORPHIC.displayHeight]);
    });

    await t.step('a display-frame crop of a rotated source has the display frame’s geometry', async () => {
      // The fixture is a 400x200 raster tagged Orientation=6: `exif-extract` derives angle 270
      // from that, and 270 is all EMS is told. The marker block's box is a fraction of the
      // 200x400 display frame, so its crop is the block's 40x40 — and the whole frame, asked
      // for beside it, is the portrait one.
      const made = await renditions(cmd, fixtures.rotated, {
        angle: ROTATED.angle,
        mimetype: 'image/jpeg',
        targets: [
          faceCropTarget(`${fixtures.dir}/crop.avif`, ROTATED.box, 0),
          { output: `${fixtures.dir}/frame.avif`, format: 'avif' },
        ],
      });
      assertEquals(made.frame, { width: ROTATED.height, height: ROTATED.width });
      assertEquals([made.targets[0].width, made.targets[0].height], [ROTATED.block.size, ROTATED.block.size]);
      assertEquals([made.targets[1].width, made.targets[1].height], [ROTATED.height, ROTATED.width]);

      // And the crop bound: a box the size of the whole frame comes back within MAX_CROP_DIMENSION
      // with its aspect kept, never enlarged.
      const bounded = await renditions(cmd, fixtures.rotated, {
        angle: ROTATED.angle,
        mimetype: 'image/jpeg',
        targets: [faceCropTarget(`${fixtures.dir}/bounded.avif`, { x: 0, y: 0, width: 1, height: 1 }, 0)],
      });
      assertEquals([bounded.targets[0].width, bounded.targets[0].height], [MAX_CROP_DIMENSION / 2, MAX_CROP_DIMENSION]);
    });
  } finally {
    await Deno.remove(fixtures.dir, { recursive: true });
  }
});
