/**
 * Whose face it is that EMS saw speaking with a voice (`speech.active_speakers`).
 *
 * The cross-modal half of speaker identity: a voice heard for the first time has nothing to
 * match against, but if the camera shows its speaker and face recognition already knows that
 * face, the voice has a name at once. The face's embedding is searched among the archive's
 * faces, and the person comes from the *region* a hit belongs to — a face embedding carries no
 * person fields, its region does (@archive/media/regions).
 */

import type { Command } from '@ein/client';
import { FACE_EMBEDDING_TYPE, regionsOfEmbeddings } from '@archive/media/regions';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Cosine similarity for a seen face to count as a known person's. */
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
