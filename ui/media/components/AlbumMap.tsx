import { type GeoBounds, MapMarkers, MapTracks, MapView } from '@ein/ui/components';
import { Box, Card, Loader, Stack, Text } from '@mantine/core';
import { execCommand, openMediaAt } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapClusterMedia } from '../../components/MapClusterMedia.tsx';
import { type MapCluster, useMapMedia } from '../../hooks/useMapMedia.ts';
import { useSpanTracks } from '../../location/hooks/useTracks.ts';
import { cellFor, clusterMarkers } from '../../lib/map-clusters.ts';
import { hitToMediaItem, type MediaHit } from '../../lib/map-hits.ts';
import type { MapFilters } from '../../lib/map-params.ts';

type AlbumMapProps = {
  /** The album or folder whose media are drawn. */
  path: string;
  /** Its span, for the tracks the devices recorded while it was taken. */
  from?: string;
  to?: string;
};

/**
 * The cell size the extent the map opens on is read in: about a kilometre, close enough to where
 * each photo was taken to fit the map to, and a few hundred cells for even a long trip.
 */
const EXTENT_CELL = 0.01;

/** The least an extent spans, in degrees: an album taken on one spot opens on its street, not on one roof. */
const EXTENT_MIN = 0.005;

/** The box everything drawn fits in; undefined when nothing has a position. */
function extentOf(points: { lat: number; lng: number }[]): GeoBounds | undefined {
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

/** Where the album's positioned media are, as cells of `EXTENT_CELL`; null while it is asked. */
function useAlbumPoints(path: string): { lat: number; lng: number }[] | null {
  const [points, setPoints] = useState<{ lat: number; lng: number }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    execCommand<{ clusters?: MapCluster[] }>(`find-within --north=90 --south=-90 --east=180 --west=-180 --cell=${EXTENT_CELL} --under ${shq(path)}`)
      .then((answer) => !cancelled && setPoints((answer.clusters ?? []).map(({ lat, lng }) => ({ lat, lng }))))
      .catch(() => !cancelled && setPoints([]));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return points;
}

/**
 * An album's media on a map, and the routes the devices recorded while they were taken.
 *
 * The media are clustered by the server as on the map page (`find-within --under`), a cell of one
 * drawn as its picture and a pile as its count, which opens the pictures behind it. The map opens
 * fitted to the media and the routes together.
 */
export function AlbumMap({ path, from, to }: AlbumMapProps) {
  const filters = useMemo((): MapFilters => ({ under: path }), [path]);
  const { clusters, loading, query } = useMapMedia({}, filters);
  const { segments, loading: tracksLoading } = useSpanTracks(from, to);
  const points = useAlbumPoints(path);
  const [zoom, setZoom] = useState(12);
  const [open, setOpen] = useState<{ cluster: MapCluster; bounds: GeoBounds } | null>(null);

  const extent = useMemo(
    () => points && extentOf([...points, ...segments.flatMap((segment) => segment.points)]),
    [points, segments],
  );

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

  // Fitted once, to the media and the routes together, so both are waited for.
  if (points === null || tracksLoading) {
    return (
      <Stack align='center' py='xl'>
        <Loader size='sm' />
      </Stack>
    );
  }

  if (!extent) {
    return <Text c='dimmed' ta='center' py='xl'>Nothing in this album has a position, and no device recorded a route while it was taken.</Text>;
  }

  return (
    <>
      <Card radius='md' p={0} style={{ overflow: 'hidden', position: 'relative' }}>
        <Box h='calc(100dvh - var(--mrx-stuck-header-height, 0px) - var(--app-shell-header-height) - 2 * var(--mantine-spacing-md))' mih={360}>
          <MapView bounds={extent} onMoveEnd={onMoveEnd} style={{ height: '100%' }}>
            <MapTracks tracks={segments} />
            <MapMarkers markers={markers} />
          </MapView>
        </Box>
        {loading && (
          <Box pos='absolute' top={10} left={10} style={{ zIndex: 1000 }} role='status' aria-label='Loading the map'>
            <Loader size={18} />
          </Box>
        )}
      </Card>
      {points.length === 0 && <Text size='sm' c='dimmed' mt='xs'>Nothing in this album has a position; the map shows the routes recorded while it was taken.</Text>}
      <MapClusterMedia open={open} filters={filters} onClose={() => setOpen(null)} />
    </>
  );
}
