/**
 * Image orientation: the one definition of "the display frame".
 *
 * A file node carries an `angle` (0/90/180/270) and a `mirror` flag. `angle` comes from EXIF
 * Orientation at index time, unless a manual override (`angleManual`, or the legacy import) is
 * present — which always wins. Past `exif-extract` the tag is never consulted again: everything
 * that rotates pixels or places a coordinate uses the node's angle, so a wrong or stale
 * Orientation tag cannot make two steps disagree.
 *
 *   display = raw rotated counter-clockwise by `angle`, then flopped when `mirror`
 *
 * which is exactly what EMS renders (`-rotate -$ANGLE`, then `-flop`), so the derivatives the
 * UI shows *are* the display frame.
 *
 * Face boxes and landmarks are stored as **fractions of the display frame** (0..1): the same
 * numbers apply to the original and to every derivative size, and reading them needs no
 * dimensions at all. Pixels appear only where a tool demands
 * them (the ImageMagick crop, a size gate) — via `toPixels`.
 */

export type Angle = 0 | 90 | 180 | 270;

/** A box in fractions of its frame: x/y is the top-left corner. */
export type FracBox = { x: number; y: number; width: number; height: number };

/** A box in pixels. */
export type PixelBox = { x: number; y: number; width: number; height: number };

export type Dims = { width: number; height: number };

/** A point in fractions of its frame. */
export type FracPoint = [number, number];

/** Anything that is not a supported quarter turn is treated as no rotation. */
export const normalizeAngle = (angle: unknown): Angle => {
  const n = typeof angle === 'number' ? angle : Number(angle);
  if (!Number.isFinite(n)) return 0;
  const a = ((Math.round(n) % 360) + 360) % 360;
  return a === 90 || a === 180 || a === 270 ? a : 0;
};

/** Truthy attr -> flag, tolerating the string forms a shell round trip produces. */
export const normalizeMirror = (mirror: unknown): boolean => mirror === true || mirror === 'true' || mirror === 1 || mirror === '1';

/**
 * Dimensions of the displayed **raster**: a quarter turn swaps them.
 *
 * Pixels, not shape. Every caller here cuts or gates on real pixels of the original — the face
 * crop, the size gate in `face-assign` — so a sample aspect ratio must *not* be applied:
 * stretching a raster this crop is measured in
 * would move the box. `pictureDims` is the one that answers "what shape does a viewer see".
 */
export const displayDims = (width: number, height: number, angle: unknown): Dims => {
  const a = normalizeAngle(angle);
  return a === 90 || a === 270 ? { width: height, height: width } : { width, height };
};

/**
 * A `sar` attr -> the number to multiply the raster's width by. 1 for anything unusable.
 *
 * The attr is written as a number, but it survives a shell round trip (`attrs -J sar=1.333333`,
 * `jq`, a JSON body) as often as not, so the string form is accepted too — as is the `4:3` /
 * `4/3` rational ffprobe and exiftool both speak, which is what a human writing one by hand
 * would reach for.
 *
 * A missing, zero, negative or non-finite ratio means "square", which is the right answer for
 * the whole still corpus and for every video whose container declares nothing.
 */
export const normalizeSar = (sar: unknown): number => {
  if (typeof sar === 'string') {
    const rational = sar.match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
    if (rational) {
      const num = Number(rational[1]);
      const den = Number(rational[2]);
      return den > 0 && num > 0 ? num / den : 1;
    }
  }
  const value = Number(sar);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

/**
 * Dimensions of the **picture**: the display raster with its pixels squared.
 *
 * `angle` is not the only thing between a stored raster and the shape it stands for. A video
 * stream may declare a sample aspect ratio — the shape of one pixel — and then the picture is
 * the raster times that ratio: an AVCHD camcorder's 1440x1080 raster at SAR 4:3 *is* a 1920x1080
 * picture, and a quarter of its width exists nowhere but in the ratio. Only the short axis grows,
 * so the answer is never smaller than the raster in either direction.
 *
 * The ratio is applied **before** the rotation, because `sar` describes the stored raster's
 * pixels and `angle` turns the result.
 *
 * This is the pair to show a human and the pair to lay a grid tile out with. It is not the pair
 * to cut pixels with — see `displayDims`.
 */
export const pictureDims = (width: number, height: number, angle: unknown, sar: unknown): Dims => {
  const ratio = normalizeSar(sar);
  // Whole pixels, because this pair is shown to a human and compared with a rendition's size.
  // ffmpeg rounds the same product *to even* (`trunc(iw*sar/2)*2`, because an encoder needs an
  // even width), so a rendition of an odd-width picture can be one pixel narrower than this.
  const squared = ratio >= 1 ? { width: Math.round(width * ratio), height } : { width, height: Math.round(height / ratio) };
  return displayDims(squared.width, squared.height, angle);
};

/**
 * The pixel aspect ratio of a raster, given the picture it stands for: `sar` as this project
 * stores it.
 *
 * The stored `width`/`height` are **whatever exiftool named**, and which raster that is depends
 * on the container: it reads an MP4's from the track header, which already has the ratio applied
 * (a 480x360 SAR 4:3 clip indexes as 640x360), while an `.MTS` offers only the coded 1440x1080.
 * So the stream's own SAR cannot be stored raw — on the MP4 it would be applied a second time
 * and paint a 16:9 clip at 2.37:1.
 *
 * What is stored instead is the ratio **relative to the raster the node holds**, which is 1
 * exactly when `width`/`height` are already the picture's shape. Every consumer then has one
 * rule — multiply the stored width by `sar` — and no consumer needs to know which tool measured
 * which container.
 *
 * `undefined` when either shape is unusable, so a caller can leave an existing value alone
 * rather than write a guess.
 */
export const sarForRaster = (picture: Partial<Dims>, stored: Partial<Dims>): number | undefined => {
  const { width: pw, height: ph } = picture;
  const { width: sw, height: sh } = stored;
  if (!pw || !ph || !sw || !sh || pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) return undefined;
  // Rounded, because the answer is stored: six decimals is finer than any ratio a container can
  // declare and keeps `1.333333` in the attrs instead of a full float expansion.
  return Math.round((pw / ph) / (sw / sh) * 1e6) / 1e6;
};

/**
 * How far from square a stored `sar` has to be before it is worth writing down.
 *
 * Both sources of a ratio are exact rationals, so a correct answer lands on 1 to the last bit
 * and only rounding — a `1.333333` read back out of an attr, a picture size an encoder rounded
 * to even — lands near it. Half a percent is far below the 4:3 (33%), 16:15 (7%) and 12:11 (9%)
 * ratios the corpus actually carries, and far above any of that noise.
 */
const SAR_EPSILON = 0.005;

/** Whether a measured ratio says anything a square-pixel assumption does not already say. */
export const isAnamorphic = (sar: number | undefined): sar is number => sar !== undefined && Math.abs(sar - 1) > SAR_EPSILON;

/**
 * An exiftool dump -> the `sar` for the raster it reported, when the dump can answer at all.
 *
 * The QuickTime family can: exiftool reads the track header, reports the **display** width as
 * `ImageWidth`, the coded one as `SourceImageWidth`, and the ratio between them as
 * `PixelAspectRatio` ("4:3"). So for an MP4 the shape is already in `width`/`height` and this
 * returns 1 — the point of computing it rather than assuming it is that the dump is checked
 * against itself, and a container whose reported raster is *not* the display frame still gets a
 * ratio out of the same three tags.
 *
 * `undefined` for a dump with no ratio in it at all — an `.MTS`, an MPEG program stream, DV in
 * an AVI. There is nothing to read there and only ffprobe can answer; see `@archive/media/media-probe`,
 * which is what `exif-extract` falls back to on exactly this answer.
 *
 * **Only ever call this for a `video/` mimetype.** `SourceImageWidth` is an EXIF tag on stills
 * (a scanner's, a raw converter's) where it describes the frame *before* a crop, not a pixel
 * shape — the same overloaded-key hazard `raw.Rotation` has.
 */
export const sarFromExifRaw = (raw: Record<string, unknown>, width: number | undefined, height: number | undefined): number | undefined => {
  if (raw.PixelAspectRatio === undefined) return undefined;
  const ratio = normalizeSar(raw.PixelAspectRatio);
  const codedWidth = Number(raw.SourceImageWidth);
  const codedHeight = Number(raw.SourceImageHeight);
  if (!Number.isFinite(codedWidth) || !Number.isFinite(codedHeight)) return undefined;
  const picture = ratio >= 1 ? { width: codedWidth * ratio, height: codedHeight } : { width: codedWidth, height: codedHeight / ratio };
  return sarForRaster(picture, { width, height });
};

/**
 * Raw-frame fractions -> display-frame fractions.
 *
 * Dimension-free: fractions of a rotated frame are just fractions of the swapped axes, which is
 * the whole reason boxes are stored this way.
 */
export const boxRawToDisplay = (box: FracBox, angle: unknown, mirror: unknown = false): FracBox => {
  const a = normalizeAngle(angle);
  let out: FracBox;

  if (a === 90) {
    // counter-clockwise: the right edge becomes the top
    out = { x: box.y, y: 1 - (box.x + box.width), width: box.height, height: box.width };
  } else if (a === 270) {
    out = { x: 1 - (box.y + box.height), y: box.x, width: box.height, height: box.width };
  } else if (a === 180) {
    out = { x: 1 - (box.x + box.width), y: 1 - (box.y + box.height), width: box.width, height: box.height };
  } else {
    out = { ...box };
  }

  // The flop is applied after the rotation, so it mirrors the display frame's x axis.
  return normalizeMirror(mirror) ? { ...out, x: 1 - (out.x + out.width) } : out;
};

/** Display-frame fractions -> raw-frame fractions (the inverse of `boxRawToDisplay`). */
export const boxDisplayToRaw = (box: FracBox, angle: unknown, mirror: unknown = false): FracBox => {
  const a = normalizeAngle(angle);
  const b = normalizeMirror(mirror) ? { ...box, x: 1 - (box.x + box.width) } : box;

  if (a === 90) return { x: 1 - (b.y + b.height), y: b.x, width: b.height, height: b.width };
  if (a === 270) return { x: b.y, y: 1 - (b.x + b.width), width: b.height, height: b.width };
  if (a === 180) return { x: 1 - (b.x + b.width), y: 1 - (b.y + b.height), width: b.width, height: b.height };
  return { ...b };
};

/** Raw-frame point -> display-frame point. Landmarks travel with their box. */
export const pointRawToDisplay = (point: FracPoint, angle: unknown, mirror: unknown = false): FracPoint => {
  const a = normalizeAngle(angle);
  const [x, y] = point;
  let out: FracPoint;

  if (a === 90) out = [y, 1 - x];
  else if (a === 270) out = [1 - y, x];
  else if (a === 180) out = [1 - x, 1 - y];
  else out = [x, y];

  return normalizeMirror(mirror) ? [1 - out[0], out[1]] : out;
};

/** Display-frame point -> raw-frame point. */
export const pointDisplayToRaw = (point: FracPoint, angle: unknown, mirror: unknown = false): FracPoint => {
  const a = normalizeAngle(angle);
  const [x, y] = normalizeMirror(mirror) ? [1 - point[0], point[1]] : point;

  if (a === 90) return [1 - y, x];
  if (a === 270) return [y, 1 - x];
  if (a === 180) return [1 - x, 1 - y];
  return [x, y];
};

/**
 * Clamp a fractional box into its frame.
 *
 * `undefined` for a box with no area left — a degenerate legacy tag, or one that fell entirely
 * outside the image.
 */
export const clampBox = (box: FracBox): FracBox | undefined => {
  const x = Math.min(Math.max(box.x, 0), 1);
  const y = Math.min(Math.max(box.y, 0), 1);
  const width = Math.min(box.width - (x - box.x), 1 - x);
  const height = Math.min(box.height - (y - box.y), 1 - y);
  if (!(width > 0) || !(height > 0)) return undefined;
  return { x, y, width, height };
};

/** Round to a fixed number of decimals so stored boxes stay readable in `attrs`. */
export const roundBox = (box: FracBox, decimals = 6): FracBox => {
  const f = 10 ** decimals;
  const r = (v: number) => Math.round(v * f) / f;
  return { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) };
};

/** Fractional box -> integer pixel box within `dims`, clamped to stay inside it. */
export const toPixels = (box: FracBox, dims: Dims): PixelBox => {
  const x = Math.min(Math.max(Math.round(box.x * dims.width), 0), Math.max(dims.width - 1, 0));
  const y = Math.min(Math.max(Math.round(box.y * dims.height), 0), Math.max(dims.height - 1, 0));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(box.width * dims.width), dims.width - x)),
    height: Math.max(1, Math.min(Math.round(box.height * dims.height), dims.height - y)),
  };
};

/**
 * EXIF Orientation tag -> the counter-clockwise `angle` that displays the raster upright.
 *
 * The one definition of that mapping.
 *
 * ## The mirrored orientations are deliberately unmapped
 *
 * EXIF defines eight values; the four that involve a flip — 2, 4, 5 and 7 — fall through to 0
 * here, exactly like an absent or nonsense tag. That is a measured decision, not an oversight:
 * nothing in the archive is mirrored, in any format (ein/core#143).
 *
 * Mapping them would add a branch no file can reach, and would need more than this function:
 * `angle` alone cannot express a flip, so half a mapping would turn orientation 2 into "upright"
 * and orientation 5 into a plain quarter turn — worse than treating both as upright consistently,
 * which is at least what every other step then assumes too.
 *
 * **If that changes, both halves change together**: this function returns the rotation, and
 * `exif-extract` must start deriving `mirror` beside the `angle` it takes from here. Adding one
 * without the other is the specific way to break a corpus that is currently self-consistent.
 */
export const angleFromExifOrientation = (orientation: number | undefined): Angle => {
  switch (orientation) {
    case 8:
      return 90;
    case 6:
      return 270;
    case 3:
      return 180;
    default:
      return 0;
  }
};

const positiveExifNumber = (raw: Record<string, unknown>, key: string): number | undefined => {
  const value = Number(raw[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * EXIF Orientation plus the stored raster facts -> the angle `exif-extract` should promote.
 *
 * A quarter-turn tag on a portrait JPEG is ambiguous. Most such files in the imported archive
 * have already had their pixels turned upright while the tag was left behind, so applying it
 * again lays them sideways. So a portrait raster keeps a quarter-turn tag only on structural
 * evidence that it is real:
 *
 * - no `ExifImageWidth`/`ExifImageHeight` (a scanner JPEG): there is no stale pre-rotation
 *   dimension pair contradicting the current raster; or
 * - panorama tags (`FullPanoHeightPixels`): they describe a composed display image whose
 *   orientation is intentional.
 *
 * Orientation 3 is applied only to a landscape raster. Raster dimensions cannot distinguish an
 * already-applied half turn, and the evidence above covers only the dimension-swapping tags.
 */
export const angleFromExifRaster = (
  raw: Record<string, unknown>,
  width: number | undefined,
  height: number | undefined,
): Angle => {
  const orientation = positiveExifNumber(raw, 'Orientation');
  const angle = angleFromExifOrientation(orientation);
  if (angle === 0 || width === undefined || height === undefined) return 0;

  if (height < width) return angle;
  if (height <= width || (angle !== 90 && angle !== 270)) return 0;

  const exifWidth = positiveExifNumber(raw, 'ExifImageWidth');
  const exifHeight = positiveExifNumber(raw, 'ExifImageHeight');
  const hasNoExifDimensions = exifWidth === undefined && exifHeight === undefined;
  const isPanorama = positiveExifNumber(raw, 'FullPanoWidthPixels') !== undefined ||
    positiveExifNumber(raw, 'FullPanoHeightPixels') !== undefined;

  return hasNoExifDimensions || isPanorama ? angle : 0;
};

/**
 * HEIF `irot` -> the counter-clockwise `angle` that displays the raster upright.
 *
 * A multiplication rather than a table, because the box already speaks this convention: the HEIF
 * `ImageRotation` box stores the turn "in anti-clockwise direction, in units of 90 degrees", which
 * is `angle` divided by 90. exiftool surfaces it as `Rotation`, numerically 0-3.
 *
 * **`Rotation` means four different things depending on where it came from**, and the ungrouped
 * dump `exif-extract` reads cannot tell them apart on its own — hence the mimetype gates at both
 * call sites:
 *
 *   - `[QuickTime]` on a HEIF — quarter turns anti-clockwise, 0-3. This function.
 *   - `[Composite]` on a video — degrees clockwise from the track display matrix.
 *   - `[Panasonic]` on a still — an EXIF *orientation code*.
 *   - `[Canon]` on a still — degrees.
 *
 * So `Rotation: 3` is three quarter turns on a HEIC and three degrees read as a video matrix, and
 * the second reading silently does nothing rather than failing. exiftool's own words are
 * *clockwise* ("Rotate 90 CW" for 3), which is the opposite sense again; the numeric is the one
 * that matches `angle` directly.
 *
 * ## This is the only turn libheif makes
 *
 * An EXIF Orientation on a HEIF moves nothing when it is decoded; `irot` is the turn. Which
 * turn a decoder has already applied is EMS's to reconcile; `exif-extract` only derives the
 * node's angle from it.
 */
export const angleFromHeifRotation = (rotation: number | undefined): Angle => normalizeAngle((rotation ?? 0) * 90);

/**
 * Containers libheif reads: the family whose `Rotation` is the `irot` above.
 *
 * AVIF belongs here even though nothing in the archive was shot as one: it is the same container
 * with a different codec, and exiftool calls a `.heic` re-encoded by ImageMagick `image/avif`.
 * The indexer and the renderer have to agree on what a HEIF is, or the residual EMS applies is
 * computed against the wrong frame. It costs the AVIFs we generate ourselves nothing: crops and
 * derivatives are written stripped of both an `irot` and an EXIF orientation, so the branch
 * finds nothing to apply.
 */
const HEIF_MIMETYPES: ReadonlySet<string> = new Set([
  'image/avif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

/** Whether libheif is what will open this file — in ImageMagick as much as in PIL. */
export const isHeifMimetype = (mimetype: string): boolean => HEIF_MIMETYPES.has(mimetype);

/**
 * A video container's display matrix -> the counter-clockwise `angle` that displays it upright.
 *
 * MP4/MOV keep rotation in the track display matrix rather than in a tag, and exiftool reports it
 * as the Composite `Rotation` tag in **degrees clockwise to display**, while `angle` is
 * counter-clockwise (`display = raw rotated CCW by angle`) — so the two are complements. 90 -> 270
 * is the common iPhone case.
 *
 * `undefined` rather than 0 for anything a quarter turn cannot express, so a caller can tell "the
 * matrix asks for no turn" from "the matrix said nothing" and leave an angle it derived elsewhere
 * alone.
 *
 * **Only ever call this for a `video/` mimetype.** In an ungrouped exiftool dump `Rotation` is an
 * overloaded key: [Panasonic] writes EXIF orientation *codes* there on stills, [Canon] writes
 * degrees, and a HEIF's `irot` arrives as quarter turns (`angleFromHeifRotation`). Reading this
 * one without the mimetype gate turns a Panasonic `6` into 6 degrees.
 *
 * Every caller shares this one mapping and has to: `exif-extract` derives the angle at index
 * time, `promote-exif-attrs --angle` re-derives it for indexed files, and the legacy importer
 * adds it to an imported angle, which is a *residual* on top of this same turn.
 */
export const angleFromVideoRotation = (rotation: unknown): Angle | undefined => {
  const n = Number(rotation);
  if (!Number.isFinite(n)) return undefined;
  const cw = ((Math.round(n) % 360) + 360) % 360;
  return cw === 90 || cw === 180 || cw === 270 ? normalizeAngle(360 - cw) : undefined;
};
