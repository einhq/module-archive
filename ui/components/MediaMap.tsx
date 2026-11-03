import { MapMarkers, MapView } from '@ein/ui/components';
import { Box, Center, Loader } from '@mantine/core';
import { execCommand, openMediaAt } from '@ein/ui/signals';
import type { GeoBounds, PositionPoint } from '@ein/ui/lib';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { MapClusterMedia } from './MapClusterMedia.tsx';
import { filterFlags, type MapCluster, useMapMedia } from '../hooks/useMapMedia.ts';
import { cellFor, clusterMarkers } from '../lib/map-clusters.ts';
import { hitToMediaItem, type MediaHit } from '../lib/map-hits.ts';
import type { MapFilters } from '../lib/map-params.ts';

/**
 * The cell size the extent the map opens on is read in: about a kilometre, close enough to where
 * each photo was taken to fit the map to, and a few hundred cells for even a long trip.
 */
const EXTENT_CELL = 0.01;

/** The least an extent spans, in degrees: media taken on one spot open on its street, not on one roof. */
const EXTENT_MIN = 0.005;

/** The box everything drawn fits in; undefined when nothing has a position. */
function extentOf(points: PositionPoint[]): GeoBounds | undefined {
  if (points.length === 0) return undefined;
  const bounds = { north: -90, south: 90, east: -180, west: 180 };
  for (const { lat, lng } of points) {
    bounds.north = Math.max(bounds.north, lat);
    bounds.south = Math.min(bounds.south, lat);
    bounds.east = Math.max(bounds.east, lng);
    bounds.west = Math.min(bounds.west, lng);
  }
  const pad = (span: number) => Math.max(0, (EXTENT_MIN - span) / 2);
  const lat = pad(bounds.north - bounds.south);
  const lng = pad(bounds.east - bounds.west);
  return { north: bounds.north + lat, south: bounds.south - lat, east: bounds.east + lng, west: bounds.west - lng };
}

/** Where the media `filters` admit are, as cells of `EXTENT_CELL`; null while it is asked. */
function useMediaPoints(filters: MapFilters): PositionPoint[] | null {
  const [points, setPoints] = useState<PositionPoint[] | null>(null);
  const flags = filterFlags(filters);
  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    execCommand<{ clusters?: MapCluster[] }>(`find-within --north=90 --south=-90 --east=180 --west=-180 --cell=${EXTENT_CELL}${flags}`)
      .then((answer) => !cancelled && setPoints((answer.clusters ?? []).map(({ lat, lng }) => ({ lat, lng }))))
      .catch(() => !cancelled && setPoints([]));
    return () => {
      cancelled = true;
    };
  }, [flags]);
  return points;
}

type MediaMapProps = {
  /** Which media are drawn: an album's (`under`), a location's (`location`). */
  filters: MapFilters;
  /** Where the other things drawn are, which the map opens fitted to with the media; null while they are read. */
  around: PositionPoint[] | null;
  /** Drawn under the media: routes, a shape, pins. */
  layers?: ReactNode;
  /** Over the map's foot, told whether any of the media has a position. */
  note?: (placed: boolean) => ReactNode;
  /** Shown instead of a map when neither the media nor `around` have a position. */
  empty: ReactNode;
};

/**
 * Media on a map, clustered by the server as on the map page (`find-within`): a cell of one drawn
 * as its picture and a pile as its count, which opens the pictures behind it. The map opens fitted
 * to the media and `around` together, and fills the box it is given.
 */
export function MediaMap({ filters, around, layers, note, empty }: MediaMapProps) {
  const { clusters, loading, query } = useMapMedia({}, filters);
  const points = useMediaPoints(filters);
  const [zoom, setZoom] = useState(12);
  const [open, setOpen] = useState<{ cluster: MapCluster; bounds: GeoBounds } | null>(null);

  const extent = useMemo(() => points && around && extentOf([...points, ...around]), [points, around]);

  const onMoveEnd = useCallback((bounds: GeoBounds, z: number) => {
    setZoom(z);
    query(bounds, cellFor(z));
  }, [query]);

  // The arrow keys in the lightbox walk every picture drawn as a picture, not just the one clicked.
  const singles = useMemo(() => clusters.flatMap((cluster) => cluster.hit ? [cluster.hit] : []), [clusters]);
  const openHit = useCallback((hit: MediaHit) => {
    openMediaAt(Math.max(singles.findIndex((candidate) => candidate.id === hit.id), 0), singles.map(hitToMediaItem));
  }, [singles]);

  const markers = useMemo(
    () => clusterMarkers(clusters, zoom, openHit, (cluster, bounds) => setOpen({ cluster, bounds })),
    [clusters, zoom, openHit],
  );

  // Fitted once, to everything drawn, so all of it is waited for.
  if (points === null || around === null) {
    return (
      <Center h='100%'>
        <Loader size='sm' />
      </Center>
    );
  }

  if (!extent) return empty;

  const foot = note?.(points.length > 0);
  return (
    <Box h='100%' pos='relative'>
      <MapView bounds={extent} onMoveEnd={onMoveEnd} style={{ height: '100%' }}>
        {layers}
        <MapMarkers markers={markers} />
      </MapView>
      {loading && (
        <Box pos='absolute' top={10} left={10} style={{ zIndex: 1000 }} role='status' aria-label='Loading the map'>
          <Loader size={18} />
        </Box>
      )}
      {foot && (
        <Box pos='absolute' bottom={10} left={10} maw='calc(100% - 20px)' style={{ zIndex: 1000 }}>
          {foot}
        </Box>
      )}
      <MapClusterMedia open={open} filters={filters} onClose={() => setOpen(null)} />
    </Box>
  );
}
