/**
 * Writing a face crop from its source and the stored box — the VFS half of
 * @archive/media/face-crop, which is only what the crop *is*. The source is an image, or the
 * frame of a video its region was seen in.
 *
 * A face crop is a rendition like any other: `<file>/regions/<region>/image.avif`, carrying the
 * source's id. It is written by the detector rather than by the derivative ladder, so the
 * write lives here, where the detector, `generate-derivatives` and every other caller reach the
 * same crop from the same attrs — and an interrupted write is retried by a `regenerate` sweep.
 */

import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import { MAX_RENDITION_TARGETS, poster, renditions, stepExitCode } from '@ems/client';
import { FACE_CROP_MIMETYPE, FACE_CROP_NAME, faceCropTarget } from '@archive/media/face-crop';
import { REGION_TYPE, regionsPathOf } from '@archive/media/regions';
import { type FracBox, normalizeAngle, normalizeMirror } from '@media/orientation';

/** What a crop needs off the source image's file node: the display frame the box is a fraction of. */
type FaceSourceAttrs = {
  mimetype?: string;
  angle?: unknown;
  mirror?: unknown;
};

const isFaceBox = (value: unknown): value is FracBox => {
  if (typeof value !== 'object' || value === null) return false;
  const box = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) => typeof box[key] === 'number' && Number.isFinite(box[key]));
};

/**
 * One crop to cut: where it goes, and the stored box it is of. On a video `at` is the second
 * the box was seen at (the region's `atSeconds`); without one the crop comes from the frame
 * EMS takes for a poster.
 */
export type FaceCropRequest = { output: string; box: FracBox; at?: number };

const isVideo = (source: FaceSourceAttrs): boolean => (source.mimetype ?? '').startsWith('video/');

/** A video's crops by the frame they are cut from, in the order first asked for. */
const byFrame = (crops: ReadonlyArray<FaceCropRequest>): FaceCropRequest[][] => {
  const frames = new Map<number | undefined, FaceCropRequest[]>();
  for (const crop of crops) {
    const same = frames.get(crop.at);
    if (same) same.push(crop);
    else frames.set(crop.at, [crop]);
  }
  return [...frames.values()];
};

/** `items` in runs of at most `MAX_RENDITION_TARGETS`, what one EMS call takes. */
const perCall = <T>(items: ReadonlyArray<T>): T[][] => {
  const calls = [];
  for (let start = 0; start < items.length; start += MAX_RENDITION_TARGETS) calls.push(items.slice(start, start + MAX_RENDITION_TARGETS));
  return calls;
};

/**
 * A crop that was not cut, and why. `code` is what a step that wanted it exits with
 * (`stepExitCode`): `STEP_EXIT_TEMPORARY` when EMS could not do it yet, so asking again later can.
 */
export type FaceCropFailure = { output: string; reason: string; code: number };

/**
 * Cut every crop of one image and record their bytes; returns the crops that were not cut. A
 * photo's crops are one `image.renditions` call per `MAX_RENDITION_TARGETS` of them, a video's one
 * `video.poster` call per frame they are cut from and as many targets; a group photo has more faces
 * than one call takes. A call that fails fails its own crops and no others: a video's other frames
 * are still cut.
 *
 * Calls of many crops rather than one per face, because each call decodes the whole source. The stored
 * boxes are fractions of the display frame and dimension-free; EMS turns them into pixels
 * against the raster it decodes, so no dimensions travel with them — a RAW's embedded preview
 * against its sensor image, and a HEIC libheif has already turned, are its to reconcile. The
 * node's `angle`/`mirror` are the only orientation authority, exactly as for detection.
 *
 * `file-sync` is what puts `size` on the node, and `size > 0` is what every reader — the sweep
 * in `find-broken-renditions`, the skip in `generate-derivatives` — uses to mean "written".
 * Skipping it leaves a crop that exists on disk and reads as broken.
 */
export const writeFaceCrops = async (
  cmd: Command,
  input: string,
  crops: ReadonlyArray<FaceCropRequest>,
  source: FaceSourceAttrs,
): Promise<FaceCropFailure[]> => {
  const frame = {
    angle: normalizeAngle(source.angle),
    mirror: normalizeMirror(source.mirror),
    ...(source.mimetype ? { mimetype: source.mimetype } : {}),
  };
  const cut = (group: FaceCropRequest[]) => {
    const targets = group.map((crop) => faceCropTarget(crop.output, crop.box));
    if (!isVideo(source)) return renditions(cmd, input, { ...frame, targets });
    const at = group[0].at;
    return poster(cmd, input, { ...frame, ...(at !== undefined ? { at } : {}), targets });
  };

  const failed: FaceCropFailure[] = [];
  const written = [];
  for (const group of isVideo(source) ? byFrame(crops).flatMap(perCall) : perCall(crops)) {
    try {
      written.push(...(await cut(group)).targets);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push(...group.map((crop) => ({ output: crop.output, reason, code: stepExitCode(error) })));
    }
  }

  const uncut = new Set(failed.map((failure) => failure.output));
  for (const crop of crops) {
    if (uncut.has(crop.output)) continue;
    const sync = await cmd.execute(`file-sync ${shq(crop.output)}`);
    if (sync.code === 0) continue;
    failed.push({ output: crop.output, reason: sync.stderr.trim() || 'file-sync failed', code: 1 });
    uncut.add(crop.output);
  }

  // The encoded size, as EMS reports it, so a grid of crops can lay itself out before a single
  // one has decoded instead of reflowing as they arrive. After the sync, which writes attrs of
  // its own.
  for (const rendition of written) {
    if (!(rendition.width > 0 && rendition.height > 0)) continue;
    if (uncut.has(rendition.path)) continue;
    await cmd.sys.vfs.update(cmd.access, rendition.path, { attrs: { width: rendition.width, height: rendition.height } });
  }

  return failed;
};

/** `writeFaceCrops` for one face; `at` is a video region's `atSeconds`. Returns why it was not cut, or null. */
export const writeFaceCrop = async (cmd: Command, input: string, output: string, box: FracBox, source: FaceSourceAttrs, at?: unknown): Promise<string | null> =>
  (await writeFaceCrops(cmd, input, [{ output, box, ...secondOf(at) }], source))[0]?.reason ?? null;

/** `{ at }` for a usable second, nothing otherwise. */
const secondOf = (at: unknown): { at?: number } => typeof at === 'number' && Number.isFinite(at) ? { at } : {};

type FaceCropRebuild = {
  /** Crop paths written by this pass. */
  written: string[];
  /** Crop paths whose rebuild failed, with the reason and the exit code a step would give it (`FaceCropFailure`). */
  failed: { path: string; reason: string; code: number }[];
  /** Faces left alone because their crop already had bytes. */
  present: number;
  /** Faces with no usable box. */
  invalid: number;
};

/**
 * Rebuild every face crop under `source` that has no bytes — or all of them, with `force`.
 *
 * Every region under `regions/` is covered: `detect-faces` writes `face-<n>`, while imports and
 * the lightbox write `manual-<n>`. A stored box is a stored box either way. A face whose crop node is
 * missing entirely gets one created, the same way a missing rendition does anywhere else in the
 * ladder; the interruption that leaves a 0-byte node can just as easily land one step earlier.
 */
export const rebuildFaceCrops = async (
  cmd: Command,
  options: {
    /** VFS path of the source image. */
    source: string;
    /** Node id of the source image — what marks a crop as a rendition of it. */
    sourceId: string;
    /** Attrs of the source image's file node. */
    attrs: FaceSourceAttrs;
    /** Re-encode crops that already have bytes. */
    force?: boolean;
    /** Called with a line per face considered. */
    log?: (message: string) => Promise<void>;
  },
): Promise<FaceCropRebuild> => {
  const { source, sourceId, attrs, force = false, log } = options;
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const result: FaceCropRebuild = { written: [], failed: [], present: 0, invalid: 0 };

  const facesPath = regionsPathOf(source);
  let faces;
  try {
    faces = await vfs.children<{ faceBox?: unknown; atSeconds?: unknown }>(access, facesPath);
  } catch {
    return result; // nothing has been detected here
  }
  if (faces.length === 0) return result;

  const wanted: FaceCropRequest[] = [];
  for (const face of faces) {
    if (face.node.type !== REGION_TYPE) continue;

    const facePath = `${facesPath}/${face.name}`;
    const cropPath = `${facePath}/${FACE_CROP_NAME}`;

    if (!isFaceBox(face.node.attrs.faceBox)) {
      result.invalid++;
      await log?.(`${cropPath}: no usable box, skipping`);
      continue;
    }

    // Present means "has bytes", not "has a node": the crop node is created before the cut
    // runs, so an interrupted or failed write leaves one behind with nothing in it.
    let crop;
    try {
      crop = await vfs.get<{ size?: number }>(access, cropPath);
    } catch {
      crop = undefined;
    }

    if (!force && crop && Number(crop.attrs.size ?? 0) > 0) {
      result.present++;
      await log?.(`${cropPath} exists, skipping (use -f to force)`);
      continue;
    }

    if (!crop) {
      // sourceId (the media node) marks the crop as a rendition: media-index's trigger skips
      // it, so the crop does not re-enter the pipeline as an original, and it routes to the
      // volatile storage tier.
      await vfs.create(access, 'file', facePath, FACE_CROP_NAME, {
        attrs: { mimetype: FACE_CROP_MIMETYPE, sourceId },
      });
    }

    await log?.(`Generating ${cropPath}...`);
    wanted.push({ output: cropPath, box: face.node.attrs.faceBox, ...secondOf(face.node.attrs.atSeconds) });
  }

  const failed = await writeFaceCrops(cmd, source, wanted, attrs);
  for (const crop of wanted) {
    const failure = failed.find((entry) => entry.output === crop.output);
    if (failure) result.failed.push({ path: crop.output, reason: failure.reason, code: failure.code });
    else result.written.push(crop.output);
  }

  return result;
};
