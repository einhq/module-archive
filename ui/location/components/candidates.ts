import type { GeocodeCandidate } from '../hooks/useLocationDetail.ts';
import type { MapMarkerSpec } from '@ein/ui/components';

/**
 * The geocoder's suggestions as numbered pins, so a list and the map name the
 * same thing. Without `onClick` they are reference only — shown while a shape
 * is drawn by hand, where "none of these, but just north of 2" is exactly the
 * case manual placement exists for, and a stray click must not apply one.
 */
export const candidateMarkers = (
  candidates: readonly GeocodeCandidate[],
  opts: { active?: number | null; onHover?: (index: number | null) => void; onClick?: (candidate: GeocodeCandidate) => void } = {},
): MapMarkerSpec[] =>
  candidates.map((candidate, index) => ({
    id: `candidate-${index}`,
    lat: candidate.lat,
    lng: candidate.lng,
    pinNumber: index + 1,
    active: opts.active === index,
    label: candidate.displayName,
    onHover: opts.onHover ? (over: boolean) => opts.onHover!(over ? index : null) : undefined,
    onClick: opts.onClick ? () => opts.onClick!(candidate) : undefined,
  }));

/**
 * A viewport showing every suggestion at once. Suggestions can sit on top of
 * each other, and a zero-size box makes `fitBounds` slam to maximum zoom, so
 * the box always gets some extent.
 */
export const candidateBounds = (candidates: readonly GeocodeCandidate[]) => {
  if (candidates.length === 0) return undefined;
  const lats = candidates.map((c) => c.lat);
  const lngs = candidates.map((c) => c.lng);
  const north = Math.max(...lats), south = Math.min(...lats);
  const east = Math.max(...lngs), west = Math.min(...lngs);
  const padLat = Math.max((north - south) * 0.2, 0.0015);
  const padLng = Math.max((east - west) * 0.2, 0.0015);
  return { north: north + padLat, south: south - padLat, east: east + padLng, west: west - padLng };
};
