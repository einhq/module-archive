/**
 * What a face crop is: the rendition EMS is asked for when one face is cut out of an image.
 *
 * Shared by `detect-faces`, the rebuild in `@archive/media/face-crop-rebuild`, the legacy importer and
 * `tag-transfer` so the four cannot drift. A crop is the one place a stored fractional box
 * becomes pixels, and it is EMS that does the cutting — rotating the whole raster into the
 * display frame first, then cropping with the display-frame box, then resolving the fraction
 * against the raster it actually decoded (`image.renditions` with `crop`). Cropping the raw
 * raster and then rotating the cutout would put it somewhere else on every rotated image.
 */

import type { Box, RenditionTarget } from '@ems/client';
import { type Dims, type FracBox, type PixelBox, toPixels } from '@archive/media/orientation';

/** Padding around the box, as a fraction of its size — a face reads better with some margin. */
export const CROP_PADDING = 0.3;

/**
 * The crop node's name and mimetype. Every writer and reader of a crop must agree, so they take
 * them from here.
 */
export const FACE_CROP_NAME = 'image.avif';
export const FACE_CROP_MIMETYPE = 'image/avif';

/**
 * libheif's AVIF quality scale. 70 rather than the ladder's 60: a crop is a few hundred pixels,
 * so the bytes are noise either way, and this is the image a human reads to decide who someone
 * is.
 */
export const CROP_QUALITY = 70;

/**
 * Longest encoded edge of a face crop.
 *
 * The largest consumer is the 96 CSS-pixel crop on the unidentified-people cards. Four
 * device pixels per CSS pixel leaves headroom even on the densest screens the UI is likely
 * to meet; retaining anything larger only makes the browser transfer and decode pixels it
 * immediately throws away. This is a bound, not a target: small source crops stay untouched.
 */
export const MAX_CROP_DIMENSION = 384;

/** A stored box clamped to the frame, which is what EMS accepts and what a legacy box may not be. */
export const clampFaceBox = (box: FracBox): Box => {
  const x = Math.min(Math.max(box.x, 0), 1);
  const y = Math.min(Math.max(box.y, 0), 1);
  return { x, y, width: Math.min(Math.max(box.width, 0), 1 - x), height: Math.min(Math.max(box.height, 0), 1 - y) };
};

/**
 * The rendition EMS is asked for: the padded box cut out of the display frame, then bounded
 * to MAX_CROP_DIMENSION without ever being enlarged (`contain` never upscales).
 */
export const faceCropTarget = (output: string, box: FracBox, padding = CROP_PADDING): RenditionTarget => ({
  output,
  format: 'avif',
  quality: CROP_QUALITY,
  crop: clampFaceBox(box),
  pad: padding,
  box: { width: MAX_CROP_DIMENSION, height: MAX_CROP_DIMENSION },
  fit: 'contain',
});

/**
 * The padded display-frame rectangle a crop covers, in pixels of `dims` (the display frame).
 *
 * What EMS cuts, computed here from the node's dimensions so a sweep can tell whether an
 * existing crop is already within the encoded bound without asking for a re-encode.
 */
export const faceCropRect = (box: FracBox, dims: Dims, padding = CROP_PADDING): PixelBox => {
  const pixels = toPixels(box, dims);
  const padX = Math.round(pixels.width * padding);
  const padY = Math.round(pixels.height * padding);
  const x = Math.max(0, pixels.x - padX);
  const y = Math.max(0, pixels.y - padY);
  const width = Math.min(pixels.width + 2 * padX, dims.width - x);
  const height = Math.min(pixels.height + 2 * padY, dims.height - y);
  return { x, y, width, height };
};
