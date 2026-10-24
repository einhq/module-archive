/**
 * Media on a map as the server clusters it (`find-within --cell`): the grid size for a zoom, the
 * cell a cluster stands for, and the markers that draw them — a picture for a cell of one, a
 * counted pile for a cell of several.
 */

import type { GeoBounds, MapMarkerSpec } from '@ein/ui/components';
import { kindFill } from '@ein/ui/lib';
import type { MapCluster } from '../hooks/useMapMedia.ts';
import type { MediaHit } from './map-hits.ts';

/**
 * Grid size the server clusters into, in degrees: 64 px at this zoom, a little more than a pile's
 * 48 px picture, so two markers in neighbouring cells do not overlap.
 *
 * The client owns this number because only the client knows what a degree is
 * worth in pixels (a 256 px tile spans 360 / 2^zoom degrees); the server just buckets by it.
 */
export const cellFor = (zoom: number): number => 360 / (Math.pow(2, zoom) * 4);

/** The cell's own bounds, back out of the key the server grouped it under. */
function cellBounds(cluster: MapCluster, cell: number): GeoBounds {
  const [gx, gy] = cluster.key.split(':').map(Number);
  return { west: gx * cell, east: (gx + 1) * cell, south: gy * cell, north: (gy + 1) * cell };
}

/** Media has no kind of its own; the album hue is the one pictures already wear everywhere else. */
const MEDIA_COLOR = kindFill('album');

/**
 * One marker per cluster: a cell of one is its picture and opens it (`openHit`), a cell of several
 * is a pile with its count and opens the pictures behind it (`openCluster`, with the cell's bounds).
 */
export function clusterMarkers(
  clusters: MapCluster[],
  zoom: number,
  openHit: (hit: MediaHit) => void,
  openCluster: (cluster: MapCluster, bounds: GeoBounds) => void,
): MapMarkerSpec[] {
  const cell = cellFor(zoom);
  return clusters.map((cluster): MapMarkerSpec => {
    const hit = cluster.hit;
    if (hit) {
      return {
        id: `m-${hit.id}`,
        lat: hit.lat,
        lng: hit.lng,
        thumbnailUrl: hit.thumbnailUrl,
        label: hit.filePath.split('/').pop(),
        onClick: () => openHit(hit),
      };
    }
    // A number always opens the pictures behind it. Zooming to break a
    // cluster apart is something the map's own controls already do.
    return {
      id: `c-${cluster.key}`,
      lat: cluster.lat,
      lng: cluster.lng,
      thumbnailUrl: cluster.cover?.thumbnailUrl,
      badge: cluster.count,
      color: MEDIA_COLOR,
      label: `${cluster.count} photos — click to browse`,
      onClick: () => openCluster(cluster, cellBounds(cluster, cell)),
    };
  });
}
