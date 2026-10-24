/**
 * A person's cover: a `coverPhoto` softlink child pointing at one of their face crops.
 *
 * The same link albums, locations and devices carry, so every reader already knows how to draw
 * it. What
 * differs is the target. An album's cover is one of its pictures; a person's is the crop of
 * their own face, `<image>/regions/<region>/image.avif`, because a photo the person is *in* is
 * mostly somebody else's birthday, and the crop is the one rendition that is known to show
 * them.
 *
 * The pick is deterministic, not random like an album's: faces a human put the name to (a
 * legacy tag, a `manual` assignment, a `transfer` from a tag) before the recognizer's guesses,
 * then photos where they are the only face — a portrait rather than a group, whose crop's
 * padding is not full of other people's ears — then confident detections before doubtful
 * ones (the detector's score is the nearest thing to "nothing in the way": a half-hidden face
 * scores low), then faces looking into the camera before faces of unknown pose before faces
 * turned away (`pose`), then the largest face in display pixels: the
 * crop is capped at 384 px, and a face that was 40 px in the photo is a blur at any size. A tag —
 * a region with no face embedding, drawn by hand or too poor to keep its vector — counts as of
 * unknown pose whatever it stores.
 *
 * An explicit cover is never replaced. A cover is replaced when its target no longer resolves,
 * or when it is a face crop whose face now belongs to somebody else — split off, merged away,
 * marked "not a person" — because then the person's card shows a stranger.
 *
 * A link this writes carries `autoCover: true`. "Set as cover" and the importer write links
 * without it, which is how `repick` — choosing again after the rules above change — tells a
 * pick it may redo from a choice somebody made.
 */

import { type Access, faceEmbeddingsOf, type FaceNodeAttrs, isUnnamed, type PersonNodeAttrs, regionsOf, type Vfs } from '@archive/people/person';
import { setCover } from '@ein/client';

import { COVER_LINK_NAME } from '@ein/paths';
import { FACE_CROP_NAME } from '@archive/media/face-crop';

/** A region crop path, `<image>/regions/<region>/image.avif`, split into its region and image. */
const FACE_CROP_PATH = /^((.*)\/regions\/[^/]+)\/image\.avif$/;

/** A detection below this is often a profile, a poster or a pattern in the wallpaper. */
const CONFIDENT_DETECTION = 0.7;

/** Assignments a person made rather than a model: `undefined` is a legacy tag. */
const HUMAN_SOURCES = new Set([undefined, 'manual', 'transfer']);

/**
 * Facing the camera: how far a head may be turned, nodded or tilted, in degrees, and still count.
 * A three-quarter view reads as a person; a profile reads as an ear.
 */
const FACING_LIMITS = { yaw: 25, pitch: 20, roll: 20 };

/** How many ranked candidates to probe for a crop before giving up. */
const CROP_PROBES = 20;

type FaceBox = { x: number; y: number; width: number; height: number };
type FacePose = { pitch: number; yaw: number; roll: number };
type CoverFaceAttrs = FaceNodeAttrs & { faceBox?: FaceBox; pose?: FacePose | null };
/** `faceCount` is what `detect-faces` found; an image it never reached has none. */
type ImageAttrs = { width?: number; height?: number; angle?: number | string; faceCount?: number };

/** Marks a cover link as picked here rather than chosen by somebody. */
const AUTO_COVER_ATTR = 'autoCover';

type WritePersonCoverOptions = {
  /** Pick again even over a usable cover, when that cover was picked automatically. */
  repick?: boolean;
};

/** The owner-side result of one `writePersonCover`. */
export type PersonCoverResult = { path: string; cover: string; replaced?: string };

/** The region a crop was cut from, or undefined when the path is not a region crop. */
const faceOfCrop = (target: string): string | undefined => FACE_CROP_PATH.exec(target)?.[1];

/**
 * Where the current cover points, and whether it still stands for this person.
 *
 * `usable` is false for no link, a dangling one, and a face crop whose face moved to somebody
 * else. Any other resolving target — a whole photo set by hand, a legacy cover — is kept.
 */
const currentCover = async (vfs: Vfs, access: Access, personPath: string, personId: string): Promise<{ target?: string; usable: boolean; auto: boolean }> => {
  let target: string | undefined;
  let auto = false;
  try {
    const link = await vfs.get<Record<string, unknown>>(access, `${personPath}/${COVER_LINK_NAME}`, { readlink: true });
    target = link.props.softlink;
    auto = link.attrs[AUTO_COVER_ATTR] === true;
  } catch {
    return { usable: false, auto };
  }
  if (!target) return { usable: false, auto };
  try {
    const node = await vfs.get(access, target);
    if (node.type !== 'file') return { target, usable: false, auto };
  } catch {
    return { target, usable: false, auto };
  }
  const face = faceOfCrop(target);
  if (!face) return { target, usable: true, auto };
  try {
    const faceNode = await vfs.get<CoverFaceAttrs>(access, face);
    return { target, usable: faceNode.attrs.personId === personId, auto };
  } catch {
    return { target, usable: false, auto };
  }
};

/** 0 facing the camera, 1 pose unknown (detected before EMS reported one, or drawn by hand), 2 turned away. */
const facingRank = (pose: FacePose | null | undefined): number => {
  if (!pose || ![pose.pitch, pose.yaw, pose.roll].every((v) => typeof v === 'number' && Number.isFinite(v))) return 1;
  const facing = Math.abs(pose.yaw) <= FACING_LIMITS.yaw && Math.abs(pose.pitch) <= FACING_LIMITS.pitch && Math.abs(pose.roll) <= FACING_LIMITS.roll;
  return facing ? 0 : 2;
};

/** The face's shorter side in display pixels, or its fractional side when the image has no size. */
const faceSize = (box: FaceBox | undefined, image: ImageAttrs | undefined): number => {
  if (!box) return 0;
  const width = typeof image?.width === 'number' ? image.width : 0;
  const height = typeof image?.height === 'number' ? image.height : 0;
  if (!width || !height) return Math.min(box.width, box.height);
  // The box is in the display frame; the stored size is the raster's.
  const angle = Number(image?.angle ?? 0);
  const [displayWidth, displayHeight] = angle === 90 || angle === 270 ? [height, width] : [width, height];
  return Math.min(box.width * displayWidth, box.height * displayHeight);
};

/**
 * The person's faces, best cover first: human-assigned, alone in the photo, confidently
 * detected, facing the camera, largest.
 *
 * One query for the regions, one batched child lookup for which are faces and one batched read
 * for their images, whatever the count.
 */
const rankFaces = async (vfs: Vfs, access: Access, personId: string): Promise<string[]> => {
  const rows = await regionsOf(vfs, access, personId);
  if (rows.length === 0) return [];
  const fileIds = [...new Set(rows.map((row) => (row.node.attrs as CoverFaceAttrs).fileId).filter((id): id is string => !!id))];
  const [images, embeddings] = await Promise.all([vfs.getNodesByIds<ImageAttrs>(access, fileIds), faceEmbeddingsOf(vfs, access, rows.map((row) => row.id))]);

  const ranked = rows.map((row) => {
    const attrs = row.node.attrs as CoverFaceAttrs;
    const image = attrs.fileId ? images.get(attrs.fileId)?.attrs : undefined;
    return {
      path: row.absPath,
      human: HUMAN_SOURCES.has(attrs.personSource) ? 0 : 1,
      crowded: image?.faceCount === 1 ? 0 : 1,
      doubtful: typeof attrs.confidence === 'number' && attrs.confidence < CONFIDENT_DETECTION ? 1 : 0,
      turned: embeddings.has(row.id) ? facingRank(attrs.pose) : 1,
      size: faceSize(attrs.faceBox, image),
    };
  });
  ranked.sort((a, b) => a.human - b.human || a.crowded - b.crowded || a.doubtful - b.doubtful || a.turned - b.turned || b.size - a.size || a.path.localeCompare(b.path));
  return ranked.map((face) => face.path);
};

/**
 * The crop of the best face that has one.
 *
 * A crop can be missing — `detect-faces` only crops an image of known size, a failed crop
 * leaves an empty node for the rebuild, and crops live in the volatile tier — so the ranking
 * is walked until one has bytes.
 */
const pickFaceCover = async (vfs: Vfs, access: Access, personId: string): Promise<string | undefined> => {
  const faces = await rankFaces(vfs, access, personId);
  for (const face of faces.slice(0, CROP_PROBES)) {
    const crop = `${face}/${FACE_CROP_NAME}`;
    try {
      const node = await vfs.get<{ size?: number }>(access, crop);
      if (node.type === 'file' && (node.attrs.size ?? 0) > 0) return crop;
    } catch {
      // No crop node at all; try the next face.
    }
  }
  return undefined;
};

/**
 * Give one person a face cover when they have none, or theirs shows somebody else.
 *
 * Unnamed people are skipped: the unidentified page draws their crops directly, recognition
 * mints and merges them by the thousand, and a link on each would be churn nobody sees.
 * Returns undefined when nothing was written.
 */
export const writePersonCover = async (
  vfs: Vfs,
  access: Access,
  personPath: string,
  { repick = false }: WritePersonCoverOptions = {},
): Promise<PersonCoverResult | undefined> => {
  const node = await vfs.get<PersonNodeAttrs>(access, personPath, { follow: false });
  if (node.type !== 'person' || isUnnamed(node.attrs)) return undefined;

  const current = await currentCover(vfs, access, personPath, node.id);
  if (current.usable && !(repick && current.auto)) return undefined;

  const cover = await pickFaceCover(vfs, access, node.id);
  if (!cover) return undefined;
  // A repick that lands where it already was writes nothing.
  if (current.usable && cover === current.target) return undefined;

  await setCover(vfs, access, personPath, cover, { attrs: { [AUTO_COVER_ATTR]: true } });
  return current.target ? { path: personPath, cover, replaced: current.target } : { path: personPath, cover };
};
