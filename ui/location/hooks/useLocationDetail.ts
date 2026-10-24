import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import type { PositionShape } from '@ein/ui/components';
import { NodeChildEntry, NodeOwnership, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';

/** A geocoder answer that was not certain enough to apply on its own. */
export type GeocodeCandidate = {
  lat: number;
  lng: number;
  displayName: string;
  type: string;
  importance: number;
};

export type LocationDetail = {
  id: string; // node/directory name under /locations
  path: string;
  name: string;
  description?: string;
  /** The address as written — what geocoding takes as input. */
  address?: string;
  /** What a geocoder resolved that address to. */
  displayName?: string;
  country?: string;
  city?: string;
  geocodedAt?: string;
  geocodeStatus?: 'applied' | 'review' | 'none';
  /** Where the coordinates came from, once there are any. */
  locationSource?: 'media-centroid' | 'nominatim' | 'manual';
  /** `media-centroid` only: how many geotagged files the position rests on. */
  locationPoints?: number;
  /** `media-centroid` only: how far those files spread, in meters. */
  locationSpread?: number;
  /** Present when geocoding was inconclusive; the user picks one. */
  candidates: GeocodeCandidate[];
  ownership: NodeOwnership;
  shape: PositionShape | null;
};

export type ResidentEntry = {
  id: string; // person slug (link name)
  name: string;
  from?: string;
  to?: string;
};

/** A geocoded address points at a building, so an accepted suggestion stays tight. */
const CANDIDATE_RADIUS_M = 50;

type UseLocationDetailResult = {
  location: LocationDetail | null;
  residents: ResidentEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  saveShape: (shape: PositionShape) => Promise<void>;
  /** Place this location at one of the geocoder's suggestions, and close the review. */
  acceptCandidate: (candidate: GeocodeCandidate) => Promise<void>;
};

type RelationAttrs = {
  relation?: { from?: string; to?: string; peerLink?: string };
};

function parseShape(data: unknown): PositionShape | null {
  if (!data || typeof data !== 'object') return null;
  const shape = data as PositionShape;
  if (typeof shape.lat !== 'number' || typeof shape.lng !== 'number') return null;
  return shape;
}

/**
 * Fetch a single location (location node under /locations): node attrs + ownership,
 * shape (registry JSON) and residents (relation links with from/to dates).
 */
export function useLocationDetail(id: string | undefined): UseLocationDetailResult {
  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [residents, setResidents] = useState<ResidentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchLocation = useCallback(async () => {
    if (!id) return;
    const path = `${LOCATIONS_ROOT}/${id}`;

    try {
      setLoading(true);
      setError(null);

      const [siblings, shapeData] = await Promise.all([
        execCommand<NodeChildEntry[]>(`ls -l ${LOCATIONS_ROOT}`),
        execCommand<unknown>(`cat ${shq(`${path}/position`)}`).catch(() => null),
      ]);

      const entry = siblings.find((e) => e.name === id && e.node.type === 'location');
      if (!entry) {
        setLocation(null);
        setResidents([]);
        return;
      }

      const attrs = entry.node.attrs as Record<string, unknown>;
      setLocation({
        id,
        path,
        name: (attrs.name as string) || (attrs.displayName as string) || id,
        description: attrs.description as string | undefined,
        // A node with neither `address` nor `geocodedAt` holds its written
        // address in `displayName`.
        address: (attrs.address as string | undefined) ??
          (attrs.geocodedAt ? undefined : attrs.displayName as string | undefined),
        displayName: attrs.displayName as string | undefined,
        country: attrs.country as string | undefined,
        city: attrs.city as string | undefined,
        geocodedAt: attrs.geocodedAt as string | undefined,
        geocodeStatus: attrs.geocodeStatus as LocationDetail['geocodeStatus'],
        locationSource: attrs.locationSource as LocationDetail['locationSource'],
        locationPoints: typeof attrs.locationPoints === 'number' ? attrs.locationPoints : undefined,
        locationSpread: typeof attrs.locationSpread === 'number' ? attrs.locationSpread : undefined,
        candidates: Array.isArray(attrs.geocodeCandidates) ? attrs.geocodeCandidates as GeocodeCandidate[] : [],
        ownership: {
          mode: entry.node.props.mode,
          uid: entry.node.props.uid,
          gid: entry.node.props.gid,
        },
        shape: parseShape(shapeData),
      });

      let links: NodeChildEntry[] = [];
      let people: NodeChildEntry[] = [];
      try {
        [links, people] = await Promise.all([
          execCommand<NodeChildEntry[]>(`ls -l ${shq(`${path}/residents`)}`),
          execCommand<NodeChildEntry[]>(`ls -l ${PEOPLE_ROOT}`),
        ]);
      } catch {
        // no residents directory
      }

      const personNames = new Map(
        people.map((p) => [p.name, ((p.node.attrs as Record<string, unknown>).name as string) || p.name]),
      );

      setResidents(
        links
          .filter((l) => l.node.type === 'softlink')
          .map((l): ResidentEntry => {
            const relation = (l.node.attrs as RelationAttrs).relation;
            return {
              id: l.name,
              name: personNames.get(l.name) ?? l.name,
              from: relation?.from,
              to: relation?.to,
            };
          }),
      );
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setLocation(null);
      setResidents([]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchLocation();
  }, [fetchLocation]);

  const saveShape = useCallback(async (shape: PositionShape) => {
    if (!id) return;
    const path = `${LOCATIONS_ROOT}/${id}`;
    const shapePath = `${path}/position`;

    if (shape.polygon && shape.polygon.length >= 3) {
      const ring = shape.polygon.map((p) => ({ lat: p.lat, lng: p.lng }));
      await execCommand(`position-set ${shq(shapePath)} --polygon ${shq(JSON.stringify(ring))}`);
    } else if (shape.radius && shape.radius > 0) {
      await execCommand(`position-set ${shq(shapePath)} --lat=${shape.lat} --lng=${shape.lng} --radius=${Math.round(shape.radius)}`);
    } else {
      await execCommand(`position-set ${shq(shapePath)} --lat=${shape.lat} --lng=${shape.lng}`);
    }

    // The shape is now the answer: provenance and any pending review move with it (`geocode-location --drawn`).
    await execCommand(`geocode-location ${shq(path)} --drawn`);

    await fetchLocation();
  }, [id, fetchLocation]);

  /**
   * Accept one of the geocoder's suggestions: `geocode-location --accept`, which
   * also answers the review the geocoder asked for (see there).
   */
  const acceptCandidate = useCallback(async (candidate: GeocodeCandidate) => {
    if (!id) return;
    const path = `${LOCATIONS_ROOT}/${id}`;

    // The command takes the suggestion by its location in the stored list, which is the list this page shows.
    const index = (location?.candidates ?? []).indexOf(candidate);
    if (index < 0) return;
    await execCommand(`geocode-location ${shq(path)} --accept ${index} --radius=${CANDIDATE_RADIUS_M}`);

    await fetchLocation();
  }, [id, location, fetchLocation]);

  return { location, residents, loading, error, refetch: fetchLocation, saveShape, acceptCandidate };
}
