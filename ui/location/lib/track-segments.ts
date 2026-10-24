import type { TrackPoint } from '@archive/location/api';

type TrackSegment = {
  /** UTC date, `YYYY-MM-DD`. What the color is keyed on. */
  day: string;
  points: TrackPoint[];
};

const EARTH_RADIUS_M = 6371000;
const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Distance along a run of points, in metres.
 *
 * Summed per segment rather than over the raw list, so a gap or a day boundary
 * does not add the straight line the tracker never travelled. Decimated points
 * cut corners, so this is a floor on the real distance — which is the honest
 * answer for a thinned track.
 */
export function trackDistance(segments: TrackSegment[]): number {
  let total = 0;

  for (const segment of segments) {
    for (let i = 1; i < segment.points.length; i++) {
      const a = segment.points[i - 1];
      const b = segment.points[i];
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lng - a.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }
  }

  return total;
}
