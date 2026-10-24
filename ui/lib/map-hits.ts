/**
 * Turning `find-within` rows into map markers. Free of the shell client, so it is testable
 * without a browser runtime.
 */

import { LOCATIONS_ROOT } from '@archive/paths';
import type { MediaItem } from '@ein/ui/signals';
import { displayDims, displayUrl, fileUrl, imageSrcSet, THUMB_NAME, typeFromPath } from '@ein/ui/lib';
import { albumPathOf } from '../media/lib/album-path.ts';

/**
 * What the media node above a hit says about itself.
 *
 * The dimensions are what a justified grid needs to lay a tile out at the right
 * shape *before* the image decodes. Without them every tile is assumed 3:2 and
 * the rows re-justify as the pictures arrive.
 */
type HitFacts = {
  /** The media node's wall clock, when it has one — what a caption shows. */
  takenAt?: string;
  /** Its instant, which is what the paging cursor is built from. */
  takenAtUtc?: string;
  /** Stored raster dimensions — pre-rotation, as `displayAspect()` expects. */
  width?: number;
  height?: number;
  /** Pixel aspect ratio of that raster; only an anamorphic video carries one. */
  sar?: number;
  /** Display rotation in degrees; 90 and 270 swap width and height. */
  angle?: number;
};

/** One row from `find-within`: a point, and every path that resolves to it. */
export type MapHit = HitFacts & {
  id: string;
  lat: number;
  lng: number;
  paths: string[];
};

/** A geotagged media file (a `<file>/position` child hit). */
export type MediaHit = HitFacts & {
  id: string;
  lat: number;
  lng: number;
  /** VFS path of the file node. */
  filePath: string;
  thumbnailUrl: string;
  /** Full VFS path of the album holding the file, when it lives under /albums. */
  albumPath?: string;
};

/** A location (a location node under /locations, reported for its shape) hit. */
export type LocationHit = {
  id: string;
  lat: number;
  lng: number;
  locationId: string;
};

/**
 * A hit that arrived without coordinates of its own.
 *
 * The lone picture inside a cluster is reported under the cell that holds it,
 * and the cell already says where it is — so the row carries what the hit *is*
 * and nothing about where. Naming that in the type is the point: passing one
 * of these to `classifyHits` unchanged builds a marker at `(undefined,
 * undefined)`, and Leaflet only complains once it is asked to draw it.
 */
export type HitContent = Omit<MapHit, 'lat' | 'lng'>;

/** Location a hit at coordinates it did not come with, and classify it as media. */
export function positionedMediaHit(hit: HitContent, lat: number, lng: number): MediaHit | undefined {
  return classifyHits([{ ...hit, lat, lng }]).media[0];
}

export function classifyHits(hits: MapHit[]): { media: MediaHit[]; locations: LocationHit[] } {
  const media: MediaHit[] = [];
  const locations: LocationHit[] = [];

  for (const hit of hits) {
    const locationId = hit.paths.map((p) => p.startsWith(`${LOCATIONS_ROOT}/`) ? p.slice(LOCATIONS_ROOT.length + 1) : '').find((id) => id !== '' && !id.includes('/'));
    if (locationId) {
      locations.push({ id: hit.id, lat: hit.lat, lng: hit.lng, locationId });
      continue;
    }

    const positionPath = hit.paths.find((p) => p.endsWith('/position'));
    if (!positionPath) continue;
    const filePath = positionPath.slice(0, -'/position'.length);

    media.push({
      id: hit.id,
      lat: hit.lat,
      lng: hit.lng,
      filePath,
      thumbnailUrl: `${fileUrl(filePath)}/thumbnails/${THUMB_NAME}`,
      albumPath: albumPathOf(filePath),
      takenAt: hit.takenAt,
      takenAtUtc: hit.takenAtUtc,
      width: hit.width,
      height: hit.height,
      sar: hit.sar,
      angle: hit.angle,
    });
  }

  return { media, locations };
}

/**
 * A hit as a lightbox item.
 *
 * A marker only exists because the file has a position child, which the media
 * pipeline writes alongside the derivatives — so the derivatives are there.
 */
export function hitToMediaItem(hit: MediaHit): MediaItem {
  const type = typeFromPath(hit.filePath) ?? 'photo';
  const dims = displayDims(hit);
  return {
    id: hit.id,
    name: hit.filePath.split('/').pop() ?? hit.filePath,
    type,
    mimetype: 'application/octet-stream',
    thumbnailUrl: hit.thumbnailUrl,
    fullUrl: displayUrl(hit.filePath, type, true, dims),
    srcSet: imageSrcSet(hit.filePath, type, true, dims),
    path: hit.filePath,
    hasDerivatives: true,
    takenAt: hit.takenAt,
    width: hit.width,
    height: hit.height,
    sar: hit.sar,
    angle: hit.angle,
  };
}
