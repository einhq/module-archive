import { assertEquals } from '@std/assert';
import { clampFaceBox, CROP_PADDING, CROP_QUALITY, faceCropRect, faceCropTarget, MAX_CROP_DIMENSION } from '@archive/media/face-crop';

Deno.test('a face crop is one padded, bounded rendition of the display-frame box', () => {
  assertEquals(faceCropTarget('/img/faces/face-0/image.avif', { x: 0.1, y: 0.2, width: 0.48, height: 0.384 }), {
    output: '/img/faces/face-0/image.avif',
    format: 'avif',
    quality: CROP_QUALITY,
    crop: { x: 0.1, y: 0.2, width: 0.48, height: 0.384 },
    pad: CROP_PADDING,
    box: { width: MAX_CROP_DIMENSION, height: MAX_CROP_DIMENSION },
    // `contain` never upscales, so a crop already within the bound keeps its own pixels.
    fit: 'contain',
  });
});

Deno.test('a legacy box that leaves the frame is clamped before it is sent', () => {
  assertEquals(clampFaceBox({ x: 0.9, y: -0.1, width: 0.3, height: 0.5 }), { x: 0.9, y: 0, width: 0.09999999999999998, height: 0.5 });
  assertEquals(faceCropTarget('/x', { x: 1.2, y: 0.5, width: 0.1, height: 0.1 }).crop, { x: 1, y: 0.5, width: 0, height: 0.1 });
});

Deno.test('the pixel rectangle a crop covers is padded and clamped to the frame', () => {
  assertEquals(faceCropRect({ x: 0.1, y: 0.2, width: 0.48, height: 0.384 }, { width: 800, height: 1000 }, 0), { x: 80, y: 200, width: 384, height: 384 });
  assertEquals(faceCropRect({ x: 0.1, y: 0.2, width: 0.5, height: 0.75 }, { width: 1600, height: 1200 }, 0), { x: 160, y: 240, width: 800, height: 900 });
  // Padding by 0.3 of the box on each side; the bottom edge runs out of frame and is cut there.
  assertEquals(faceCropRect({ x: 0.5, y: 0.8, width: 0.2, height: 0.2 }, { width: 1000, height: 1000 }), { x: 440, y: 740, width: 320, height: 260 });
});
