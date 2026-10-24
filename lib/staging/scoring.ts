/**
 * Auto-album scoring — pure functions that turn raw per-signal comparisons into
 * [0,1] similarities and combine them with configurable weights. Kept free of
 * core/IO imports so it is trivially unit-testable (fast tier) and reusable
 * from the clustering hot loop.
 *
 * Temporal, location and people are live; visual / semantic / camera / file are
 * declared in the weights and simply stay absent until those signals exist —
 * `combineScores` renormalizes over what is present. Geometry math is inlined
 * (no core dep).
 */

import type { AlbumScores } from '@archive/media/api';
import { haversineMeters } from '@ein/client';

/** Default half-life for temporal decay: 2 hours (in ms). */
export const DEFAULT_TIME_HALFLIFE_MS = 2 * 60 * 60 * 1000;
/** Default characteristic radius for location decay: 500 m. */
export const DEFAULT_LOCATION_SCALE_M = 500;

/**
 * Temporal similarity from a time gap: exponential decay so 0 gap -> 1 and one
 * half-life -> 0.5. `halfLifeMs` sets how quickly proximity falls off.
 */
export const temporalSimilarity = (gapMs: number, halfLifeMs = DEFAULT_TIME_HALFLIFE_MS): number => {
  if (!Number.isFinite(gapMs) || halfLifeMs <= 0) return 0;
  return Math.pow(0.5, Math.abs(gapMs) / halfLifeMs);
};

/**
 * Location similarity from a distance in metres: exponential decay so same spot
 * -> 1 and `scaleM` metres -> ~0.37 (1/e). Absent coordinates should be scored
 * by the caller (treat as unknown, not as 0).
 */
export const locationSimilarity = (distanceMeters: number, scaleM = DEFAULT_LOCATION_SCALE_M): number => {
  if (!Number.isFinite(distanceMeters) || scaleM <= 0) return 0;
  return Math.exp(-Math.abs(distanceMeters) / scaleM);
};

/** Jaccard overlap of two id sets (people, tags…): |A∩B| / |A∪B|; empty→0. */
export const jaccard = (a: Iterable<string>, b: Iterable<string>): number => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
};

/**
 * Default signal weights. Only the signals present in a given
 * AlbumScores contribute; `combineScores` renormalizes over what is present so a
 * media file with no known people still produces a sensible overall.
 *
 * people + temporal (0.40) deliberately outweighs location (0.25): the same
 * company, minutes apart, is stronger evidence of one happening than a change of
 * address is evidence of two.
 */
export const DEFAULT_WEIGHTS: Required<Omit<AlbumScores, 'overall'>> = {
  location: 0.25,
  temporal: 0.20,
  people: 0.20,
  visual: 0.15,
  semantic: 0.10,
  file: 0.05,
  camera: 0.03,
};

/**
 * Weighted combination of the present per-signal scores, renormalized over the
 * signals that are actually set (undefined = "not computed / unknown", which is
 * excluded rather than counted as 0). Returns 0 when nothing is present.
 */
export const combineScores = (
  scores: AlbumScores,
  weights: Partial<typeof DEFAULT_WEIGHTS> = DEFAULT_WEIGHTS,
): number => {
  let sum = 0;
  let wTotal = 0;
  for (const [key, w] of Object.entries(weights) as [keyof typeof DEFAULT_WEIGHTS, number][]) {
    const v = scores[key];
    if (v === undefined || v === null || !Number.isFinite(v)) continue;
    sum += v * w;
    wTotal += w;
  }
  return wTotal === 0 ? 0 : sum / wTotal;
};

export { haversineMeters };
