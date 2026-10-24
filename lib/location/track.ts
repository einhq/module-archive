/**
 * Shared helpers for the track commands: which track a device names, handle
 * access, the point shape, and the listing of every device's track.
 *
 * A track is the route a device recorded, kept as the device's child `track`.
 * What a track is without reading it — point count, span, extent — is the
 * track registry's alone; nothing copies it onto the node.
 */
import { DEVICES_ROOT } from '@archive/paths';
import type { TrackEntry } from '@archive/location/api';
import type { Command } from '@ein/client';
import { resolve } from '@std/path';

/** The name of a device's track. */
const TRACK_CHILD = 'track';

/** A coordinate point. `ts` is the track's primary key, so it is never optional at rest. */
export type TrackPoint = {
  lat: number;
  lng: number;
  /** ISO timestamp of the fix. */
  ts?: string;
  alt?: number;
  speed?: number;
  course?: number;
};

/** Bounding box of a track. */
type TrackBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

type TrackSegment = {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  points: TrackPoint[];
};

export type TrackReadOptions = {
  bounds?: TrackBounds;
  margin?: number;
  from?: string;
  to?: string;
  tolerance?: number;
  limit?: number;
};

type TrackReadResult = {
  segments: TrackSegment[];
  points: number;
  truncated: boolean;
};

/** Structural view of the core TrackHandle (modules avoid core imports). */
type TrackLikeHandle = {
  appendPoints(points: TrackPoint[]): Promise<number>;
  readPoints(opts?: TrackReadOptions): Promise<TrackReadResult>;
  close(): Promise<void>;
};

const str = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Every device under `root` that has a track, with what the registry says of it.
 *
 * One listing of the devices with their child edges says which have a track, one
 * batched read gives those tracks' nodes and one registry read their summaries,
 * so no track is opened however many there are.
 */
export async function listTracks(cmd: Command, root: string = DEVICES_ROOT): Promise<TrackEntry[]> {
  const devices = (await cmd.sys.vfs.children(cmd.access, root, { childLinks: true })).filter((entry) => entry.node.type === 'device');
  const trackIds = new Map(devices.flatMap((entry) => {
    const track = entry.children?.find((child) => child.name === TRACK_CHILD);
    return track ? [[entry.name, track.id] as const] : [];
  }));
  const ids = [...trackIds.values()];
  const [nodes, summaries] = await Promise.all([cmd.sys.vfs.getNodesByIds(cmd.access, ids), cmd.sys.vfs.trackSummaries(cmd.access, ids)]);

  return devices.flatMap((entry): TrackEntry[] => {
    const id = trackIds.get(entry.name) ?? '';
    const node = nodes.get(id);
    const summary = summaries.get(id);
    if (!node || node.type !== 'track' || !summary) return [];
    const device = `${root}/${entry.name}`;
    return [{
      id: entry.name,
      device,
      path: `${device}/${TRACK_CHILD}`,
      nodeId: id,
      name: str((entry.node.attrs as Record<string, unknown>).name) ?? entry.name,
      description: str((node.attrs as Record<string, unknown>).description),
      ...summary,
    }];
  });
}

/**
 * The track a target names, and the device it belongs to. A device — its slug, or its
 * path — stands for its `track` child, whether or not that exists yet; a track node
 * stands for itself.
 */
export async function trackOf(cmd: Command, target: string): Promise<{ path: string; device: string }> {
  const path = target.includes('/') ? resolve(cmd.cwd, target) : `${DEVICES_ROOT}/${target}`;
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type === 'device') return { path: `${path}/${TRACK_CHILD}`, device: path };
  if (node.type === 'track') return { path, device: path.slice(0, path.lastIndexOf('/')) || '/' };
  throw new Error(`${path}: not a device or a track (is ${node.type})`);
}

/** A device's track, made empty when it has none yet. Returns its path. */
export async function ensureTrack(cmd: Command, target: string): Promise<string> {
  const { path, device } = await trackOf(cmd, target);
  await cmd.sys.vfs.ensure(cmd.access, 'track', device, TRACK_CHILD);
  return path;
}

/** Open the track a target names (see `trackOf`), verifying its type. Caller closes. */
export async function openTrack(cmd: Command, target: string, mode: 'r' | 'a' | 'w'): Promise<{ path: string; handle: TrackLikeHandle }> {
  const { path, device } = await trackOf(cmd, target);
  let node;
  try {
    node = await cmd.sys.vfs.get(cmd.access, path);
  } catch {
    throw new Error(`${device} has no track yet (track-create ${device})`);
  }
  if (node.type !== 'track') {
    throw new Error(`${path}: not a track node (is ${node.type})`);
  }
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode });
  return { path, handle: handle as unknown as TrackLikeHandle };
}

/** Validate and normalize a point; throws on invalid lat/lng/ts. */
export function toPoint(raw: Record<string, unknown>): TrackPoint {
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('point needs numeric lat and lng');
  }

  const point: TrackPoint = { lat, lng };

  if (raw.ts !== undefined) {
    const ts = new Date(String(raw.ts));
    if (Number.isNaN(ts.getTime())) {
      throw new Error(`invalid ts: ${raw.ts}`);
    }
    point.ts = ts.toISOString();
  }

  for (const key of ['alt', 'speed', 'course'] as const) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      if (Number.isFinite(value)) point[key] = value;
    }
  }

  return point;
}

/** Parse a `north,south,east,west` flag. */
export function parseBounds(input: string): TrackBounds {
  const parts = input.split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error(`invalid --bbox '${input}' (expected north,south,east,west)`);
  }
  const [north, south, east, west] = parts;
  return { north, south, east, west };
}

const TRKPT_RE = /<trkpt\b([^>]*)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;

/** What a GPX file says about itself and its fixes. */
type Gpx = {
  /** The `creator` attribute: the program or device that wrote the file. */
  creator?: string;
  /** Every `<name>` in it — the file's, its tracks' — in document order. */
  names: string[];
  points: TrackPoint[];
};

/** Read a GPX document: its `<trkpt>` fixes (lat/lon in either order, optional `<ele>` and `<time>`), creator and names. */
export function parseGpx(xml: string): Gpx {
  const points: TrackPoint[] = [];

  for (const match of xml.matchAll(TRKPT_RE)) {
    const attrs = match[1];
    const lat = Number(attrs.match(/\blat="([^"]+)"/)?.[1]);
    const lng = Number(attrs.match(/\blon="([^"]+)"/)?.[1]);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const point: TrackPoint = { lat, lng };
    const body = match[2] ?? '';

    const ele = body.match(/<ele>([^<]+)<\/ele>/);
    if (ele && Number.isFinite(Number(ele[1]))) point.alt = Number(ele[1]);

    const time = body.match(/<time>([^<]+)<\/time>/);
    if (time) {
      const ts = new Date(time[1]);
      if (!Number.isNaN(ts.getTime())) point.ts = ts.toISOString();
    }

    points.push(point);
  }

  // Names inside a point (`<trkpt><name>`) are waypoint labels, not what wrote the file.
  const outside = xml.replace(TRKPT_RE, '');
  const creator = xml.match(/<gpx\b[^>]*\bcreator="([^"]*)"/)?.[1]?.trim() || undefined;
  const names = [...outside.matchAll(/<name>\s*(?:<!\[CDATA\[)?([^<\]]*?)(?:\]\]>)?\s*<\/name>/g)].map((m) => m[1].trim()).filter(Boolean);

  return { creator, names, points };
}

/** Lower-case words, space-separated and padded: `Garmin eTrex 30x` and `garmin-etrex-30x` read the same. */
const words = (text: string): string => ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;

/**
 * The devices a GPX file could have come from: those whose name, make and model, or serial
 * number appears, as whole words, in its creator or one of its names. Labels shorter than
 * three characters are too ambiguous to count.
 */
export function devicesForGpx<D extends { name: string; make?: string; model?: string; serialNumber?: string }>(devices: D[], gpx: Pick<Gpx, 'creator' | 'names'>): D[] {
  const said = [gpx.creator, ...gpx.names].filter((text): text is string => Boolean(text)).map(words);
  return devices.filter((device) => {
    const labels = [device.name, [device.make, device.model].filter(Boolean).join(' '), device.serialNumber ?? '']
      .map(words)
      .filter((label) => label.trim().length >= 3);
    return labels.some((label) => said.some((text) => text.includes(label)));
  });
}
