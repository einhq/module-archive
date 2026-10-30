/**
 * The boxes on an image or a video: `media-region` nodes under `<file>/regions/`, in one place.
 *
 * Every box on a picture is a region — a detection, a box somebody drew in the lightbox, a tag
 * imported from the legacy archive. A video's regions are its faces, one for each person
 * `detect-faces` told apart: the box is where the face was seen most clearly, at `atSeconds`,
 * `appearances` say when it is on screen, and the child `track` logs its box in every frame
 * that was looked at, one `[t, x, y, width, height]` line each. A region that shows a usable face has the face's vector as a child
 * named `embedding`; that child is what makes it a face, and nothing else does. Recognition searches embeddings and maps each hit back to its region
 * with one batched parent lookup; the person fields (`personId`, `personSource`, …) live on the
 * region. No id is stored in either direction, so the two cannot drift apart.
 *
 * `detect-faces` writes `face-<n>` with an embedding when the detection passed the quality gate
 * (`@archive/media/face-quality`). Human-drawn and imported boxes are `manual-<n>` and never have one.
 * A `face-<n>` region can lose its embedding — a human moved the box, so the vector no longer
 * describes it, or the migration found the face too poor to vote — and keeps its person without
 * voting. Only the detector's kind is reproducible, which is why "delete the faces and start
 * over" has to tell the two names apart.
 */

import type { Access, NodeVFS } from '@ein/client';

/** The directory under an image that holds its regions. */
export const REGIONS_DIR = 'regions';

/** Node type of a box on an image. */
export const REGION_TYPE = 'media-region';

/** Name of a face region's vector child. */
export const FACE_EMBEDDING_NAME = 'embedding';

/** Name and mimetype of a video face's track: its box a line per sampled frame. */
export const FACE_TRACK_NAME = 'track';
export const FACE_TRACK_MIMETYPE = 'application/x-ndjson';

/** `embeddingType` of a face vector. */
export const FACE_EMBEDDING_TYPE = 'face';

/** `detectedBy` on a region `detect-faces` wrote. */
export const FACE_DETECTOR = 'insightface-buffalo_l';

/** `detectedBy` on a box somebody drew in the lightbox. */
export const LIGHTBOX_MANUAL_DETECTOR = 'manual';

/** Node-name prefix for a detection this system produced. */
export const DETECTED_PREFIX = 'face-';

/** Node-name prefix for a box a human drew or an import carried. */
export const MANUAL_PREFIX = 'manual-';

/** Attributes of a region. The box and every person field are here, never on the embedding. */
export type RegionAttrs = {
  fileId?: string;
  /** Fractions (0..1) of the display frame — see @archive/media/orientation. */
  faceBox?: { x: number; y: number; width: number; height: number };
  /** The detector's five points (eyes, nose, mouth corners), fractions of the display frame. */
  landmarks?: [number, number][] | null;
  /** Head pose in degrees, `@archive/media/face-pose`; absent when the detection carried none. */
  pose?: { pitch: number; yaw: number; roll: number } | null;
  confidence?: number;
  /** On a video: the second `faceBox`, `landmarks` and the crop are of. */
  atSeconds?: number;
  /** On a video: when the face is on screen, `[start, end]` in seconds, in time order. */
  appearances?: [number, number][];
  detectedAt?: string;
  detectedBy?: string;
  personId?: string | null;
  personSource?: string;
  personConfidence?: number | null;
  personAssignedAt?: string;
  assignLocked?: boolean;
  /** People a human said this region is not; recognition never votes it back to them. */
  rejectedPersonIds?: string[];
  /** Set when somebody questions the face's person, or an audit of the named faces finds another person nearer; see `liveDoubt`. */
  doubt?: FaceDoubt | null;
};

/** Why a face's person is in question: somebody said so, or an audit found it. */
export type FaceDoubt = MarkedDoubt | AuditDoubt;

/** A person asked whether the face really is `personId` (`face-doubt`). */
export type MarkedDoubt = {
  /** The person the face was assigned to when it was questioned. */
  personId: string;
  /** The user who questioned it. */
  markedBy: string;
  markedAt: string;
};

/** An audit's finding on one face: it is assigned to `personId` but looks like `likePersonId`. */
export type AuditDoubt = {
  /** The person the face was assigned to when audited. */
  personId: string;
  /** The person of the nearest anchor in another photo. */
  likePersonId: string;
  /** Cosine similarity to that anchor. */
  similarity: number;
  /** Cosine similarity to the nearest anchor of `personId` in another photo. */
  ownSimilarity: number;
  auditedAt: string;
};

/** A doubt a person raised, which an audit neither repeats nor clears. */
export const isMarkedDoubt = (doubt: FaceDoubt): doubt is MarkedDoubt => typeof (doubt as MarkedDoubt).markedBy === 'string';

/**
 * The region's doubt while it still applies: the face is still on the person it was questioned
 * on, and nobody has confirmed it since. An audit questions only transferred faces, so its doubt
 * also ends when a human assigns the face. Moving a face off a person leaves its doubt behind,
 * inert, until it is cleared or the face comes back.
 */
export const liveDoubt = (attrs: RegionAttrs): FaceDoubt | undefined => {
  const doubt = attrs.doubt;
  if (!doubt || typeof doubt !== 'object' || doubt.personId !== attrs.personId) return undefined;
  if (!isMarkedDoubt(doubt) && attrs.personSource !== 'transfer') return undefined;
  return doubt;
};

/** `<image>/regions`. */
export const regionsPathOf = (imagePath: string): string => `${imagePath}/${REGIONS_DIR}`;

/** `<region>/embedding`. */
export const faceEmbeddingPathOf = (regionPath: string): string => `${regionPath}/${FACE_EMBEDDING_NAME}`;

const REGION_PATH = new RegExp(`^(.*)/${REGIONS_DIR}/([^/]+)$`);

/** The image a region path belongs to, or undefined when the path is not directly under `regions/`. */
export const imageOfRegion = (regionPath: string): string | undefined => REGION_PATH.exec(regionPath)?.[1];

/**
 * The region each face embedding belongs to: `embedding id → region id`, in one batched lookup.
 *
 * An id is absent when its node is not a face embedding where one is expected — linked under
 * another name, or hanging somewhere other than a region.
 */
export const regionsOfEmbeddings = async (vfs: NodeVFS, access: Access, embeddingIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (embeddingIds.length === 0) return out;
  const links = await vfs.getParentLinksByIds(access, embeddingIds);
  for (const [id, parents] of links) {
    const parent = parents.find((link) => link.name === FACE_EMBEDDING_NAME);
    if (parent) out.set(id, parent.parentId);
  }
  return out;
};

/** The face embedding under each region that has one: `region id → embedding id`. */
export const faceEmbeddingsOfRegions = async (vfs: NodeVFS, access: Access, regionIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (regionIds.length === 0) return out;
  const links = await vfs.getChildLinksByIds(access, regionIds);
  for (const [id, children] of links) {
    const child = children.find((link) => link.name === FACE_EMBEDDING_NAME);
    if (child) out.set(id, child.id);
  }
  return out;
};

/**
 * Drop the regions a previous detection run created, leaving human and imported boxes alone, and
 * say how many went.
 *
 * Human-drawn and imported boxes are not reproducible by any detector, so asking for fresh
 * detections must not remove them.
 */
export const removeDetectedRegions = async (
  vfs: NodeVFS,
  access: Access,
  imagePath: string,
): Promise<number> => {
  const regionsPath = regionsPathOf(imagePath);
  let entries;
  try {
    entries = await vfs.children<RegionAttrs>(access, regionsPath);
  } catch {
    return 0; // nothing detected here yet
  }

  const detected = entries.filter((entry) => entry.name.startsWith(DETECTED_PREFIX));
  // Recursive: a region owns its embedding and its crop.
  for (const entry of detected) await vfs.unlink(access, `${regionsPath}/${entry.name}`, regionsPath, { recursive: true });
  return detected.length;
};

/** The next unused `manual-<n>` among `names`: a removed index is never reused, so a new box never looks like an old one returned. */
export const nextManualName = (names: string[]): string => {
  let next = 0;
  for (const name of names) {
    if (!name.startsWith(MANUAL_PREFIX)) continue;
    const suffix = Number(name.slice(MANUAL_PREFIX.length));
    if (Number.isInteger(suffix) && suffix >= 0) next = Math.max(next, suffix + 1);
  }
  return `${MANUAL_PREFIX}${next}`;
};

/** A face: the region and the embedding under it. */
type FaceRegion = { embeddingId: string; regionId: string; regionPath: string; attrs: RegionAttrs };

/** A region without an embedding: a box and maybe a name. */
type TagRegion = { regionId: string; regionPath: string; attrs: RegionAttrs };

const QUERY_LIMIT = 500000;

/**
 * Every region in the archive, split into faces and tags, for the batch passes: two queries — all
 * face embeddings, all regions — joined on the embedding's path, `<region>/embedding`. A face
 * embedding anywhere else is left out.
 */
export const allRegions = async (vfs: NodeVFS, access: Access): Promise<{ faces: FaceRegion[]; tags: TagRegion[] }> => {
  const [embeddings, regions] = await Promise.all([
    vfs.query(access, { types: ['embedding'], where: [{ ref: 'embeddingType', op: 'eq', value: FACE_EMBEDDING_TYPE }], limit: QUERY_LIMIT }),
    vfs.query(access, { types: [REGION_TYPE], limit: QUERY_LIMIT }),
  ]);
  const suffix = `/${FACE_EMBEDDING_NAME}`;
  const embeddingByRegionPath = new Map<string, string>();
  for (const embedding of embeddings) {
    if (embedding.absPath.endsWith(suffix)) embeddingByRegionPath.set(embedding.absPath.slice(0, -suffix.length), embedding.id);
  }
  const faces: FaceRegion[] = [];
  const tags: TagRegion[] = [];
  for (const region of regions) {
    const attrs = region.node.attrs as RegionAttrs;
    const embeddingId = embeddingByRegionPath.get(region.absPath);
    if (embeddingId) faces.push({ embeddingId, regionId: region.id, regionPath: region.absPath, attrs });
    else tags.push({ regionId: region.id, regionPath: region.absPath, attrs });
  }
  return { faces, tags };
};
