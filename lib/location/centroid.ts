/**
 * Deriving a location's position from the media linked to it.
 *
 * The decision logic lives here, apart from the VFS, because it is the part
 * worth testing. A `<file>/location` link is only as
 * good as a human's memory years after the fact — so the input is a cluster of
 * points with the occasional photo attached to entirely the wrong place.
 *
 * The mean is useless against that: one link to a holiday photo 1500 km away
 * moves the centre by 1500/n km, and nothing downstream can tell that the
 * answer is nonsense. So the centre is a median, the far points are dropped,
 * and the radius comes from how far the remaining points actually spread —
 * which is also the honest description of a location. Liseberg is not a pin, it is
 * a park, and the media say how big.
 */

import { haversineMeters } from '@archive/location/geocode';

/** Structural view of the core PositionPoint (modules avoid core imports). */
export type Point = { lat: number; lng: number };

/** Below this a cluster is a building, and a tighter circle would be false precision. */
export const MIN_RADIUS_M = 25;
/** A circle bigger than this says nothing useful about where a photo was taken. */
const MAX_RADIUS_M = 50000;
/**
 * Outlier cut-off floor. Without it a cluster of GPS fixes on one building
 * (median distance ~5 m) would discard everything past 15 m — its own street.
 */
export const OUTLIER_FLOOR_M = 250;
/** How many median-distances out a point may sit before it is a different location. */
const OUTLIER_FACTOR = 3;

type CentroidOptions = {
  /** Fewest inliers that may still produce a usable answer. */
  minPoints?: number;
  /** Reject the result when the inliers spread wider than this (meters). */
  maxSpread?: number;
  /** Override the derived radius entirely. */
  radius?: number;
};

export type CentroidResult = {
  lat: number;
  lng: number;
  /** Derived from the inlier spread (p90 distance), clamped, or the override. */
  radius: number;
  /** Points that survived outlier trimming. */
  used: number;
  /** Points discarded as belonging somewhere else. */
  dropped: number;
  /** Greatest inlier distance from the centre, in meters. */
  spread: number;
  /** Why a `poor` result is not good enough to apply. */
  reason: string;
  status: 'good' | 'poor';
};

/** No points at all — distinct from a poor answer, and reported differently. */
type CentroidEmpty = { status: 'empty'; used: 0; dropped: number; reason: string };

export const DEFAULT_MIN_POINTS = 2;
export const DEFAULT_MAX_SPREAD_M = 25000;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * The p-th percentile by nearest rank, on an already-sorted array.
 *
 * p90 rather than the maximum, so the one inlier at the edge of the tolerance
 * does not set the radius for the other fifty.
 */
const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
};

/**
 * Longitudes as an unwrapped continuum around a reference angle.
 *
 * Averaging raw longitudes puts a location straddling the antimeridian (+179.98
 * and -179.99) at 0 — off the coast of Africa. Shifting each point to the
 * equivalent angle nearest the reference keeps the arithmetic local, and the
 * result is wrapped back at the end.
 *
 * The reference must be a longitude that actually occurs in the cluster, never
 * a statistic of the raw values: the median of those four points is 0, which is
 * precisely the wrong answer, so seeding the unwrap with it would preserve the
 * bug it exists to fix.
 */
const unwrapLongitudes = (lngs: number[], around: number): number[] =>
  lngs.map((lng) => {
    let value = lng;
    while (value - around > 180) value -= 360;
    while (around - value > 180) value += 360;
    return value;
  });

const wrapLongitude = (lng: number): number => {
  let value = lng;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
};

const isFinitePoint = (point: Point): boolean =>
  Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
  Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

/**
 * A robust centre for `points`, with the spread that describes it.
 *
 * Two passes: a median centre that outliers cannot move, then the mean of the
 * points close enough to it to belong. The verdict is advisory — the caller
 * decides what to do with a `poor` result — but `good` means the answer is safe
 * to write onto a location.
 */
export const centroidOf = (points: Point[], opts: CentroidOptions = {}): CentroidResult | CentroidEmpty => {
  const minPoints = opts.minPoints ?? DEFAULT_MIN_POINTS;
  const maxSpread = opts.maxSpread ?? DEFAULT_MAX_SPREAD_M;

  const valid = points.filter(isFinitePoint);
  const invalid = points.length - valid.length;

  if (valid.length === 0) {
    return { status: 'empty', used: 0, dropped: invalid, reason: 'no geotagged media linked to this location' };
  }

  // Pass 1: the median point, which a minority of outliers cannot shift.
  const medianLat = median(valid.map((p) => p.lat));
  const medianLng = wrapLongitude(median(unwrapLongitudes(valid.map((p) => p.lng), valid[0].lng)));

  const distances = valid.map((p) => haversineMeters(medianLat, medianLng, p.lat, p.lng));
  const medianDistance = median(distances);
  const cutoff = Math.max(OUTLIER_FLOOR_M, medianDistance * OUTLIER_FACTOR);

  const inliers = valid.filter((_, i) => distances[i] <= cutoff);
  const dropped = valid.length - inliers.length + invalid;

  // Pass 2: the mean of what is left, which uses every point that belongs
  // rather than only the middle one.
  const lat = inliers.reduce((sum, p) => sum + p.lat, 0) / inliers.length;
  const unwrapped = unwrapLongitudes(inliers.map((p) => p.lng), medianLng);
  const lng = wrapLongitude(unwrapped.reduce((sum, v) => sum + v, 0) / unwrapped.length);

  const spreads = inliers.map((p) => haversineMeters(lat, lng, p.lat, p.lng)).sort((a, b) => a - b);
  const spread = spreads[spreads.length - 1] ?? 0;
  const radius = opts.radius !== undefined ? opts.radius : Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(percentile(spreads, 90))));

  const base = { lat, lng, radius, used: inliers.length, dropped, spread: Math.round(spread) };

  if (inliers.length < minPoints) {
    return { ...base, status: 'poor', reason: `only ${inliers.length} geotagged file(s), needs ${minPoints}` };
  }
  if (spread > maxSpread) {
    return { ...base, status: 'poor', reason: `media spread over ${Math.round(spread)}m, wider than ${maxSpread}m` };
  }

  return { ...base, status: 'good', reason: `${inliers.length} geotagged file(s) within ${Math.round(spread)}m` };
};
