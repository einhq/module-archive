/**
 * Pure-unit tests for the display-frame conversion. Fast tier: no VFS, no tools.
 *
 * The geometry is easiest to check against a concrete raster: a 4x2 (landscape) raw image with a
 * box on its top-left quarter-ish, rotated the way EMS renders it.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  angleFromExifOrientation,
  angleFromExifRaster,
  angleFromVideoRotation,
  boxDisplayToRaw,
  boxRawToDisplay,
  clampBox,
  displayDims,
  type FracBox,
  isAnamorphic,
  normalizeAngle,
  normalizeMirror,
  normalizeSar,
  pictureDims,
  pointDisplayToRaw,
  pointRawToDisplay,
  sarForRaster,
  sarFromExifRaw,
  toPixels,
} from '../../lib/media/orientation.ts';

const ANGLES = [0, 90, 180, 270] as const;

const assertBox = (actual: FracBox, expected: FracBox, msg?: string) => {
  assertAlmostEquals(actual.x, expected.x, 1e-9, msg);
  assertAlmostEquals(actual.y, expected.y, 1e-9, msg);
  assertAlmostEquals(actual.width, expected.width, 1e-9, msg);
  assertAlmostEquals(actual.height, expected.height, 1e-9, msg);
};

Deno.test('normalizeAngle keeps quarter turns and drops everything else', () => {
  assertEquals(normalizeAngle(90), 90);
  assertEquals(normalizeAngle(270), 270);
  assertEquals(normalizeAngle('180'), 180);
  assertEquals(normalizeAngle(-90), 270);
  assertEquals(normalizeAngle(450), 90);
  // Not a quarter turn, no rotation — nothing downstream can render it anyway.
  assertEquals(normalizeAngle(45), 0);
  assertEquals(normalizeAngle(undefined), 0);
  assertEquals(normalizeAngle(''), 0);
});

Deno.test('normalizeMirror accepts the shell round trip forms', () => {
  assertEquals(normalizeMirror(true), true);
  assertEquals(normalizeMirror('true'), true);
  assertEquals(normalizeMirror(1), true);
  assertEquals(normalizeMirror(false), false);
  assertEquals(normalizeMirror('false'), false);
  assertEquals(normalizeMirror(undefined), false);
});

Deno.test('displayDims swaps the axes on a quarter turn', () => {
  assertEquals(displayDims(4000, 3000, 0), { width: 4000, height: 3000 });
  assertEquals(displayDims(4000, 3000, 90), { width: 3000, height: 4000 });
  assertEquals(displayDims(4000, 3000, 270), { width: 3000, height: 4000 });
  assertEquals(displayDims(4000, 3000, 180), { width: 4000, height: 3000 });
});

Deno.test('normalizeSar reads the rational forms both tools speak, and nothing else', () => {
  assertAlmostEquals(normalizeSar('4:3'), 4 / 3, 1e-9);
  assertAlmostEquals(normalizeSar('4/3'), 4 / 3, 1e-9);
  assertAlmostEquals(normalizeSar('1.333333'), 1.333333, 1e-9);
  assertAlmostEquals(normalizeSar(1.333333), 1.333333, 1e-9);
  // ffprobe's answer for a stream that declares nothing usable, and the attr's absence: both
  // mean square pixels, which is what every still and most video has.
  assertEquals(normalizeSar('N/A'), 1);
  assertEquals(normalizeSar('0:1'), 1);
  assertEquals(normalizeSar(undefined), 1);
  assertEquals(normalizeSar(0), 1);
  assertEquals(normalizeSar(-2), 1);
});

Deno.test('pictureDims stretches the short axis, then turns the result', () => {
  // The AVCHD case: 1080 lines in 1440 coded columns at SAR 4:3 is a 1920x1080 picture.
  assertEquals(pictureDims(1440, 1080, 0, 4 / 3), { width: 1920, height: 1080 });
  // A quarter turn swaps the *picture*, not the raster — the ratio is applied first.
  assertEquals(pictureDims(1440, 1080, 90, 4 / 3), { width: 1080, height: 1920 });
  // A sub-1 ratio grows the height instead, so nothing is ever resampled down.
  assertEquals(pictureDims(720, 576, 0, 0.9), { width: 720, height: 640 });
  // No ratio at all is the still corpus, and must change nothing.
  assertEquals(pictureDims(4000, 3000, 90, undefined), displayDims(4000, 3000, 90));
});

Deno.test('sarForRaster reduces a picture against the raster the node stores', () => {
  // An `.MTS`: exiftool reports the coded raster, so the ratio has to be stored.
  assertAlmostEquals(sarForRaster({ width: 1920, height: 1080 }, { width: 1440, height: 1080 })!, 4 / 3, 1e-6);
  // An MP4: exiftool reports the track header's display frame, which already *is* the picture,
  // so the stream's 4:3 must not be stored — applying it again would paint 16:9 at 2.37:1.
  assertEquals(sarForRaster({ width: 640, height: 360 }, { width: 640, height: 360 }), 1);
  assertEquals(sarForRaster({ width: 0, height: 360 }, { width: 640, height: 360 }), undefined);
  assertEquals(sarForRaster({ width: 640, height: 360 }, {}), undefined);
});

Deno.test('isAnamorphic ignores the rounding around 1 and nothing else', () => {
  assertEquals(isAnamorphic(1), false);
  assertEquals(isAnamorphic(undefined), false);
  assertEquals(isAnamorphic(1.001), false);
  // 16:15 (PAL 4:3) is the narrowest ratio the corpus carries, and is 6.7% from square.
  assertEquals(isAnamorphic(16 / 15), true);
  assertEquals(isAnamorphic(4 / 3), true);
});

Deno.test('sarFromExifRaw answers for a QuickTime dump and stays silent for the rest', () => {
  // What exiftool writes for a 480x360 SAR 4:3 MP4: the display frame as `ImageWidth`, the coded
  // one as `SourceImageWidth`, the ratio between them as `PixelAspectRatio`.
  const mp4 = { ImageWidth: 640, ImageHeight: 360, SourceImageWidth: 480, SourceImageHeight: 360, PixelAspectRatio: '4:3' };
  assertEquals(sarFromExifRaw(mp4, 640, 360), 1);
  // The same file's dump, if exiftool had reported the coded raster instead: the ratio is then
  // real and has to be stored. Nothing in the corpus does this; the arithmetic is checked
  // because the dump is trusted rather than assumed.
  assertAlmostEquals(sarFromExifRaw(mp4, 480, 360)!, 4 / 3, 1e-6);
  // An `.MTS` dump carries no ratio of any kind — only ffprobe can answer, which is what
  // `resolveMediaFacts` is handed a raster for.
  assertEquals(sarFromExifRaw({ ImageWidth: 1440, ImageHeight: 1080 }, 1440, 1080), undefined);
});

Deno.test('a 90 rotation moves the raw top-right corner to the display top-left', () => {
  // Rotating counter-clockwise, the right edge becomes the top.
  const topRight: FracBox = { x: 0.75, y: 0, width: 0.25, height: 0.5 };
  assertBox(boxRawToDisplay(topRight, 90), { x: 0, y: 0, width: 0.5, height: 0.25 });
  // ...and the raw top-left ends up bottom-left.
  const topLeft: FracBox = { x: 0, y: 0, width: 0.25, height: 0.5 };
  assertBox(boxRawToDisplay(topLeft, 90), { x: 0, y: 0.75, width: 0.5, height: 0.25 });
});

Deno.test('a 270 rotation moves the raw top-left corner to the display top-right', () => {
  const topLeft: FracBox = { x: 0, y: 0, width: 0.25, height: 0.5 };
  assertBox(boxRawToDisplay(topLeft, 270), { x: 0.5, y: 0, width: 0.5, height: 0.25 });
});

Deno.test('a 180 rotation flips both axes', () => {
  const box: FracBox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  assertBox(boxRawToDisplay(box, 180), { x: 0.6, y: 0.4, width: 0.3, height: 0.4 });
});

Deno.test('mirror flops the display x axis, after the rotation', () => {
  const box: FracBox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  assertBox(boxRawToDisplay(box, 0, true), { x: 0.6, y: 0.2, width: 0.3, height: 0.4 });
  // With a rotation the flop applies to the already-rotated frame, not the raw one.
  const rotated = boxRawToDisplay(box, 90);
  assertBox(boxRawToDisplay(box, 90, true), { ...rotated, x: 1 - (rotated.x + rotated.width) });
});

Deno.test('display <-> raw round-trips for every angle and mirror', () => {
  const boxes: FracBox[] = [
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { x: 0, y: 0, width: 1, height: 1 }, // whole frame
    { x: 0, y: 0.9, width: 0.05, height: 0.1 }, // hard against two edges
    { x: 0.97, y: 0, width: 0.03, height: 0.02 },
  ];

  for (const angle of ANGLES) {
    for (const mirror of [false, true]) {
      for (const box of boxes) {
        const label = `angle ${angle} mirror ${mirror}`;
        const display = boxRawToDisplay(box, angle, mirror);
        assertBox(boxDisplayToRaw(display, angle, mirror), box, label);

        const point: [number, number] = [box.x, box.y];
        const shown = pointRawToDisplay(point, angle, mirror);
        const back = pointDisplayToRaw(shown, angle, mirror);
        assertAlmostEquals(back[0], point[0], 1e-9, label);
        assertAlmostEquals(back[1], point[1], 1e-9, label);
      }
    }
  }
});

Deno.test('a box corner tracks its point through the rotation', () => {
  const box: FracBox = { x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
  for (const angle of ANGLES) {
    for (const mirror of [false, true]) {
      const display = boxRawToDisplay(box, angle, mirror);
      // Every raw corner must land on a corner of the display box.
      const corners: [number, number][] = [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height],
      ];
      for (const corner of corners) {
        const [px, py] = pointRawToDisplay(corner, angle, mirror);
        const onX = Math.abs(px - display.x) < 1e-9 || Math.abs(px - (display.x + display.width)) < 1e-9;
        const onY = Math.abs(py - display.y) < 1e-9 || Math.abs(py - (display.y + display.height)) < 1e-9;
        assertEquals(onX && onY, true, `angle ${angle} mirror ${mirror} corner ${corner}`);
      }
    }
  }
});

Deno.test('clampBox trims to the frame and rejects what is left of nothing', () => {
  assertBox(clampBox({ x: -0.1, y: 0.5, width: 0.3, height: 0.2 })!, { x: 0, y: 0.5, width: 0.2, height: 0.2 });
  assertBox(clampBox({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })!, { x: 0.9, y: 0.9, width: 0.1, height: 0.1 });
  assertEquals(clampBox({ x: 1, y: 0.5, width: 0.2, height: 0.2 }), undefined);
  assertEquals(clampBox({ x: 0.2, y: 0.2, width: 0, height: 0.2 }), undefined);
  assertEquals(clampBox({ x: -1, y: 0.2, width: 0.5, height: 0.2 }), undefined);
});

Deno.test('pixel conversion round-trips and never leaves the frame', () => {
  const dims = { width: 3000, height: 4000 };
  const box: FracBox = { x: 0.25, y: 0.5, width: 0.1, height: 0.1 };
  assertEquals(toPixels(box, dims), { x: 750, y: 2000, width: 300, height: 400 });

  // A box flush with the right edge must not produce a crop that runs past it.
  const edge = toPixels({ x: 0.99, y: 0.99, width: 0.02, height: 0.02 }, dims);
  assertEquals(edge.x + edge.width <= dims.width, true);
  assertEquals(edge.y + edge.height <= dims.height, true);
});

Deno.test('angleFromExifOrientation maps the three rotations and nothing else', () => {
  assertEquals(angleFromExifOrientation(1), 0);
  assertEquals(angleFromExifOrientation(3), 180);
  assertEquals(angleFromExifOrientation(6), 270);
  assertEquals(angleFromExifOrientation(8), 90);
});

Deno.test('angleFromExifOrientation treats the mirrored orientations as upright', () => {
  // Deliberate, and the reason exif-extract calls this one function rather than mapping inline: the
  // flip cannot be expressed as an angle, so the honest answer is the one every step agrees on.
  // See the note on angleFromExifOrientation before changing any of these.
  for (const mirrored of [2, 4, 5, 7]) {
    assertEquals(angleFromExifOrientation(mirrored), 0, `orientation ${mirrored}`);
  }
});

Deno.test('angleFromExifOrientation shrugs off an absent or out-of-range tag', () => {
  // 0 is what four camera models in the corpus write; NaN is what a reader gets when
  // exiftool prints nothing for a file with no tag at all.
  assertEquals(angleFromExifOrientation(0), 0);
  assertEquals(angleFromExifOrientation(9), 0);
  assertEquals(angleFromExifOrientation(NaN), 0);
  assertEquals(angleFromExifOrientation(undefined), 0);
});

Deno.test('angleFromExifRaster keeps the conservative landscape gate', () => {
  assertEquals(angleFromExifRaster({ Orientation: 6 }, 400, 200), 270);
  assertEquals(angleFromExifRaster({ Orientation: 8 }, 400, 200), 90);

  // The common imported shape: pixels were already made portrait, while the camera's original
  // landscape dimensions and Orientation survived. Applying the tag again would lay it sideways.
  assertEquals(
    angleFromExifRaster({ Orientation: 6, ExifImageWidth: 400, ExifImageHeight: 200 }, 200, 400),
    0,
  );
  // Matching portrait EXIF dimensions are still ambiguous (a stale shape some cameras leave),
  // so they do not weaken the gate either.
  assertEquals(
    angleFromExifRaster({ Orientation: 8, ExifImageWidth: 200, ExifImageHeight: 400 }, 200, 400),
    0,
  );
});

Deno.test('angleFromExifRaster trusts evidenced portrait-tag exceptions', () => {
  // Scanner output has no EXIF dimension pair, so there is no stale pre-rotation frame claiming
  // the pixels used to be landscape.
  assertEquals(angleFromExifRaster({ Orientation: 8 }, 925, 1193), 90);

  // Samsung's panorama metadata describes a composed display image; its quarter-turn is
  // intentional even though the stored raster dimensions are portrait.
  assertEquals(
    angleFromExifRaster({ Orientation: 8, ExifImageWidth: 2336, ExifImageHeight: 3776, FullPanoHeightPixels: 23800 }, 2336, 3776),
    90,
  );

  // The evidence does not cover half turns, whose dimensions cannot expose whether the pixels
  // were already rotated, so Orientation 3 applies only to a landscape raster.
  assertEquals(angleFromExifRaster({ Orientation: 3 }, 200, 400), 0);
});

Deno.test('angleFromVideoRotation complements the container matrix', () => {
  // `Rotation` is degrees clockwise to display; `angle` is counter-clockwise.
  assertEquals(angleFromVideoRotation(90), 270); // the common iPhone case
  assertEquals(angleFromVideoRotation(270), 90);
  assertEquals(angleFromVideoRotation(180), 180);

  // Out-of-range degrees still name a quarter turn.
  assertEquals(angleFromVideoRotation(450), 270);
  assertEquals(angleFromVideoRotation(-90), 90);
});

Deno.test('angleFromVideoRotation says undefined rather than 0 when there is no turn', () => {
  // The distinction is what lets `exif-extract` leave an angle it derived elsewhere alone, and
  // what tells the legacy importer that nothing was applied before the stored angle.
  assertEquals(angleFromVideoRotation(0), undefined);
  assertEquals(angleFromVideoRotation(undefined), undefined);
  assertEquals(angleFromVideoRotation(null), undefined);
  assertEquals(angleFromVideoRotation('not a number'), undefined);
  assertEquals(angleFromVideoRotation(45), undefined);
});

Deno.test('legacy video angles compose with the matrix into an absolute one', () => {
  // The legacy archive let ffmpeg apply the matrix and then turned by the stored angle on top, so its
  // number is a residual: absolute = legacy + matrix.
  const absolute = (legacy: number, rotation: number) => normalizeAngle(legacy + (angleFromVideoRotation(rotation) ?? 0));

  // The confirmed sample: Rotation 90, legacy 90, and a raw frame that is already upright.
  assertEquals(absolute(90, 90), 0);
  // video/quicktime with Rotation 180 and legacy 90.
  assertEquals(absolute(90, 180), 270);
  // No matrix at all — the legacy value was already absolute.
  assertEquals(absolute(90, 0), 90);
  assertEquals(absolute(270, 0), 270);
});
