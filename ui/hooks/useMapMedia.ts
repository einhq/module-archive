import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoBounds } from '@ein/ui/components';
import { classifyHits, type HitContent, type LocationHit, type MapHit, type MediaHit, positionedMediaHit } from '../lib/map-hits.ts';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { MapFilters } from '../lib/map-params.ts';

/**
 * One occupied grid cell, as `find-within --cell` reports it.
 *
 * A cell is drawn as a number, so it costs the server nothing to produce and
 * carries no content — except when it holds exactly one picture, which is drawn
 * as a thumbnail and therefore does carry it.
 */
export type MapCluster = {
  key: string;
  lat: number;
  lng: number;
  count: number;
  /** The one hit in the cell, when there is only one. */
  hit?: MediaHit;
  /** One of the cell's pictures, when it holds several: what the pile is drawn as. */
  cover?: MediaHit;
};

type UseMapMediaResult = {
  clusters: MapCluster[];
  locations: LocationHit[];
  /** Geotagged media in view, counted rather than listed. */
  total: number;
  /** Why a read is in flight: the view moved, or the search or the years changed. */
  loading: MapLoad | null;
  query: (bounds: GeoBounds, cell: number) => void;
};

/** What asked for a read: the camera, or the constraints on an unmoved view. */
type MapLoad = 'view' | 'search';

/** Inclusive year bounds; either half may be absent. */
export type YearRange = { fromYear?: number; toYear?: number };

const filterFlags = (filters: MapFilters | undefined): string =>
  !filters ? '' : [
    filters.query ? ` --q ${shq(filters.query)}` : '',
    filters.person ? ` --person ${shq(filters.person)}` : '',
    filters.location ? ` --location ${shq(filters.location)}` : '',
    filters.tag ? ` --tag ${shq(filters.tag)}` : '',
    filters.under ? ` --under ${shq(filters.under)}` : '',
  ].join('');

/**
 * `--from`/`--to` for a year range, in the vocabulary `find-within` shares with
 * `search`: `--to` covers the whole year it names, so an inclusive slider needs
 * no arithmetic here.
 *
 * Padded to four digits because that is the only form the date parser accepts —
 * and years below 1000 do occur here, from files whose EXIF date is broken
 * rather than absent, and unpadded one makes the whole query a parse error.
 */
const year = (value: number): string => String(value).padStart(4, '0');

const yearFlags = ({ fromYear, toYear }: YearRange): string =>
  [
    fromYear !== undefined ? ` --from=${year(fromYear)}` : '',
    toYear !== undefined ? ` --to=${year(toYear)}` : '',
  ].join('');

/**
 * The wire shape of a clustered answer.
 *
 * A cluster's `hit` is content only — where it is, is the cell's business.
 */
type ClusterResponse = {
  clusters: (Omit<MapCluster, 'hit' | 'cover'> & { hit?: HitContent; cover?: HitContent })[];
  results: MapHit[];
  total: number;
};

/**
 * Query geotagged media + locations inside map viewport bounds (debounced;
 * stale responses are dropped).
 *
 * The server clusters: it is asked for a grid of `cell` degrees and answers
 * with one row per occupied cell, so a whole-corpus viewport costs a few
 * hundred rows instead of tens of thousands, and the viewport needs no cap.
 *
 * `years` narrows the media by when it was taken. Locations have no date and are
 * never dropped by it — a year slider is about the pictures.
 */
export function useMapMedia(years: YearRange = {}, filters?: MapFilters): UseMapMediaResult {
  const [clusters, setClusters] = useState<MapCluster[]>([]);
  const [locations, setLocations] = useState<LocationHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState<MapLoad | null>(null);
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const lastQueryRef = useRef<{ bounds: GeoBounds; cell: number } | null>(null);

  const { fromYear, toYear } = years;
  // Filters arrive as a fresh object every render; compare by value.
  const filterKey = JSON.stringify(filters ?? {});

  const read = useCallback((bounds: GeoBounds, cell: number, reason: MapLoad) => {
    lastQueryRef.current = { bounds, cell };
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      const generation = ++generationRef.current;
      try {
        setLoading(reason);
        const result = await execCommand<ClusterResponse>(
          `find-within --north=${bounds.north} --south=${bounds.south} --east=${bounds.east} --west=${bounds.west}` +
            ` --cell=${cell} --covers` + yearFlags({ fromYear, toYear }) + filterFlags(JSON.parse(filterKey)),
        );
        if (generation !== generationRef.current) return;

        setClusters((result.clusters ?? []).map((cluster) => {
          // A lone hit goes through the same classification as an unclustered
          // one, so a `<file>/position` that resolves to nothing renderable
          // falls away here rather than becoming a broken thumbnail. It is
          // positioned by its cell, which for a cell of one is the point itself.
          const { hit: rawHit, cover: rawCover, ...cell } = cluster;
          const hit = rawHit ? positionedMediaHit(rawHit, cell.lat, cell.lng) : undefined;
          const cover = rawCover ? positionedMediaHit(rawCover, cell.lat, cell.lng) : undefined;
          return { ...cell, hit, cover };
        }));
        setLocations(classifyHits(result.results ?? []).locations);
        setTotal(result.total ?? 0);
      } catch {
        if (generation === generationRef.current) {
          setClusters([]);
          setLocations([]);
          setTotal(0);
        }
      } finally {
        if (generation === generationRef.current) setLoading(null);
      }
    }, 300) as unknown as number;
  }, [fromYear, toYear, filterKey]);

  const query = useCallback((bounds: GeoBounds, cell: number) => read(bounds, cell, 'view'), [read]);

  // Neither the slider nor the search box moves the map, so the viewport already
  // on screen has to be re-asked with the new constraints.
  useEffect(() => {
    const last = lastQueryRef.current;
    if (last) read(last.bounds, last.cell, 'search');
  }, [read]);

  return { clusters, locations, total, loading, query };
}
