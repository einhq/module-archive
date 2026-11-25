import { MapView } from '@ein/ui/components';
import { Box, Center, Loader } from '@mantine/core';
import { execCommand } from '@ein/ui/signals';
import type { GeoBounds, PositionPoint } from '@ein/ui/lib';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { filterFlags, type MapCluster } from '../hooks/useMapMedia.ts';
import type { MapFilters } from '../lib/map-params.ts';
import { MEDIA_LAYER, mediaLayerSettings } from '../lib/map-layer.ts';

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

/** What the map opens with: the media layer, the others the reader may turn on in its picker. */
const OPENING_LAYERS = [MEDIA_LAYER];

/**
 * Media on a map: the archive's media layer kept to `filters`, a cell of one drawn as its picture
 * and a pile as its count, which opens the pictures behind it; and the other layers in its picker.
 * The map opens fitted to the media and `around` together, and fills the box it is given.
 */
export function MediaMap({ filters, around, layers, note, empty }: MediaMapProps) {
  const points = useMediaPoints(filters);
  const extent = useMemo(() => points && around && extentOf([...points, ...around]), [points, around]);
  const layerSettings = useMemo(() => ({ [MEDIA_LAYER]: mediaLayerSettings(filters) }), [JSON.stringify(filters)]);

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
      <MapView bounds={extent} defaultLayers={OPENING_LAYERS} layerSettings={layerSettings} controls={{ style: true, layers: true }} style={{ height: '100%' }}>
        {layers}
      </MapView>
      {foot && (
        <Box pos='absolute' bottom={10} left={10} maw='calc(100% - 20px)' style={{ zIndex: 1000 }}>
          {foot}
        </Box>
      )}
    </Box>
  );
}
