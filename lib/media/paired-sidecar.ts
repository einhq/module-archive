/**
 * A file's paired sidecar (`<file>/sidecar`) and what is read from it (`@archive/media/paired-sidecar`):
 * the time sources it gives the resolver and the point it gives the file's `position`. Pairing
 * itself is `@archive/media/sidecars`.
 */

import type { Command } from '@ein/client';
import type { MediaSidecar, SidecarPoint } from '@archive/media/api';
import type { SidecarTime } from '@archive/media/capture-resolve';
import { POSITION_CHILD } from '@archive/location/location-link';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The child of a file that holds its paired sidecar. */
export const SIDECAR_CHILD = 'sidecar';

/** The mimetypes a sidecar is stored with: a Takeout JSON and an XMP packet. */
export const SIDECAR_MIMETYPES = ['application/json', 'application/rdf+xml'];

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A sidecar node's `sidecar` attr, when it holds one this module wrote. */
export const sidecarOf = (attrs: Record<string, unknown>): MediaSidecar | undefined => {
  const sidecar = attrs.sidecar;
  return isObject(sidecar) && (sidecar.kind === 'takeout' || sidecar.kind === 'xmp' || sidecar.kind === 'takeout-album') ? sidecar as MediaSidecar : undefined;
};

/** The paired sidecar of the file at `filePath`, through a softlink when it shares one; undefined when it has none. */
export const readSidecar = async (vfs: Vfs, access: Access, filePath: string): Promise<MediaSidecar | undefined> => {
  const node = await vfs.get(access, `${filePath}/${SIDECAR_CHILD}`).catch(() => undefined);
  return node ? sidecarOf(node.attrs as Record<string, unknown>) : undefined;
};

/** What a paired sidecar says of when its file was taken, as the time resolver takes it. */
export const sidecarTime = (sidecar: MediaSidecar | undefined): SidecarTime | undefined => {
  if (sidecar?.kind === 'xmp') return sidecar.wallClock ? { wallClock: sidecar.wallClock } : undefined;
  if (sidecar?.kind !== 'takeout' || !sidecar.takenAt) return undefined;
  return { instant: sidecar.takenAt, ...(sidecar.uploadedAt ? { uploaded: sidecar.uploadedAt } : {}) };
};

/**
 * Where a paired sidecar says its file was, when that is believed: always from an XMP packet, and
 * from a Takeout unless the file is a digitized copy, whose Google location is where it was
 * scanned or uploaded, but for a place a person set there (`whereEdited`).
 */
export const sidecarPoint = (sidecar: MediaSidecar | undefined, digitized: boolean): SidecarPoint | undefined => {
  if (sidecar?.kind === 'xmp') return sidecar.where;
  if (sidecar?.kind !== 'takeout' || !sidecar.where) return undefined;
  return !digitized || sidecar.whereEdited ? sidecar.where : undefined;
};

/** Write `point` into the `position` child of the file at `filePath`, making it when there is none. */
export const writePosition = async (vfs: Vfs, access: Access, filePath: string, point: SidecarPoint): Promise<void> => {
  await vfs.ensure(access, 'position', filePath, POSITION_CHILD);
  const handle = await vfs.open(access, `${filePath}/${POSITION_CHILD}`, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(JSON.stringify({ lat: point.lat, lng: point.lng })));
  } finally {
    await handle.close();
  }
};
