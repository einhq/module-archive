/**
 * Whose face it is that EMS saw speaking with a voice (`speech.active_speakers`).
 *
 * The cross-modal half of speaker identity: a voice heard for the first time has nothing to
 * match against, but if the camera shows its speaker and face recognition already knows that
 * face, the voice has a name at once. Two answers, kept apart:
 *
 *  - the video's own face region the speaking face is (`speakingRegion`): of the regions on
 *    screen at the moment it was seen, the one whose vector is nearest. The voice keeps the
 *    region, not its person, so whoever the region is when the voice is decided is who it votes
 *    for.
 *  - the person the face is among all the archive's faces (`personOfFace`). The person comes from
 *    the *region* a hit belongs to — a face embedding carries no person fields, its region does
 *    (@archive/media/regions).
 */

import type { Command } from '@ein/client';
import { cosine, parseVector } from '@archive/media/near-duplicates';
import { FACE_EMBEDDING_TYPE, faceEmbeddingsOfRegions, type RegionAttrs, regionsOfEmbeddings, regionsPathOf } from '@archive/media/regions';
import type { Span } from '@archive/media/speakers';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Cosine similarity for a seen face to count as a known person's, or as a region's of the video. */
const SPEAKER_FACE_MATCH_THRESHOLD = 0.5;

const occ = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v !== 'null';

/** The person a face embedding belongs to: the nearest face that is someone's, or null. */
export const personOfFace = async (vfs: Vfs, access: Access, embedding: number[]): Promise<string | null> => {
  const matches = await vfs.findSimilar(access, FACE_EMBEDDING_TYPE, new TextEncoder().encode(JSON.stringify(embedding)), 8, SPEAKER_FACE_MATCH_THRESHOLD);
  if (matches.length === 0) return null;
  const regionOf = await regionsOfEmbeddings(vfs, access, matches.map((m) => m.id));
  const regions = await vfs.getNodesByIds<{ personId?: string | null }>(access, [...new Set(regionOf.values())]);
  // Nearest first: the closest face that belongs to somebody decides.
  for (const match of matches) {
    const regionId = regionOf.get(match.id);
    const personId = regionId ? regions.get(regionId)?.attrs.personId : undefined;
    if (occ(personId)) return personId;
  }
  return null;
};

/** A face region of a video: its node id, when it is on screen, and its vector. */
type VideoFace = { id: string; appearances: Span[]; vector: number[] };

/** The face regions of a video that say when they are on screen and carry a vector. */
export const facesOfVideo = async (vfs: Vfs, access: Access, videoPath: string): Promise<VideoFace[]> => {
  const entries = await vfs.children<RegionAttrs>(access, regionsPathOf(videoPath)).catch(() => []);
  const timed = entries.filter((entry) => Array.isArray(entry.node.attrs.appearances) && entry.node.attrs.appearances.length > 0);
  const embeddings = await faceEmbeddingsOfRegions(vfs, access, timed.map((entry) => entry.node.id));
  if (embeddings.size === 0) return [];
  const vectors = await vfs.getVectors(access, FACE_EMBEDDING_TYPE, [...embeddings.values()]);
  const faces: VideoFace[] = [];
  for (const entry of timed) {
    const embeddingId = embeddings.get(entry.node.id);
    const bytes = embeddingId ? vectors.get(embeddingId) : undefined;
    const vector = bytes ? parseVector(bytes) : undefined;
    if (vector) faces.push({ id: entry.node.id, appearances: entry.node.attrs.appearances!, vector });
  }
  return faces;
};

/**
 * The video's face a face seen at `t` seconds is: the nearest of those on screen then, when it is
 * near enough. Faces on screen together are different people (detection never groups them), so
 * the nearest of them is the one, even where some other video shows the same person more like it.
 */
export const speakingRegion = (faces: VideoFace[], seen: { t: number; embedding: number[] }): VideoFace | undefined => {
  let best: { face: VideoFace; similarity: number } | undefined;
  for (const face of faces) {
    if (!face.appearances.some(([start, end]) => start <= seen.t && seen.t <= end)) continue;
    const similarity = cosine(face.vector, seen.embedding);
    if (similarity >= SPEAKER_FACE_MATCH_THRESHOLD && (!best || similarity > best.similarity)) best = { face, similarity };
  }
  return best?.face;
};
