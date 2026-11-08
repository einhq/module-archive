/**
 * Shared helpers for the track commands: which track a target names, its name and how it travels,
 * handle access, the point shape, the listing of every track, and a GPX file read into one.
 *
 * A track is a device's `track` endpoint under `/dev`, such as the `position` core's `tracker`
 * driver keeps for a phone, a GPS logger or a boat. It is what travels: how (`kind`, else its
 * device's `class`), the timezone its days are cut in, its edits to its trips (`tripEdits`) and its
 * description are its attrs, and its home bases (`homes/`), its trips (`.trips`) and the GPX files
 * it was read from (`routes/`, linked from its `sources/`) are its children. A camera that is part
 * of a device, a phone's, links the device from its child softlink `device`, and the device's track
 * is the camera's. What a track is without reading it — point count, span, extent — is the track
 * registry's alone; nothing copies it onto the node.
 */
import { DEV_PATH, devicePath } from '@ein/paths';
import { CAMERAS_ROOT } from '@archive/paths';
import type { TrackEntry } from '@archive/location/api';
import { isTravelKind } from '@archive/location/track-profile';
import { fileSource, linkSource } from '@archive/sources';
import type { Command, Gpx } from '@ein/client';
import { basename, dirname, resolve } from '@std/path';

/** The child softlink of a camera that names the device it is part of: a phone's camera, its phone. */
export const CAMERA_DEVICE_LINK = 'device';
/** The track endpoint core's `tracker` driver keeps a device's position in. */
const POSITION_ENDPOINT = 'position';
/** Core's driver for phones and GPS loggers, which reads a GPX file written to its device. */
const TRACKER_DRIVER = 'tracker';
/** The child of a track that holds the GPX files it was read from. */
const ROUTES_DIR = 'routes';
/** Where a bare name, one without a `/`, is looked for: a device, then a camera, of that name. */
const TRACK_HOLDER_ROOTS = [DEV_PATH, CAMERAS_ROOT];
/** What a command's track argument takes (`trackOf`), as its spec says it. */
export const TRACK_ARG = "the track's path, or a device or a camera linked to one, by its path or its name";

const NODE_TYPE_TRACK = 'track';
const NODE_TYPE_DEVICE = 'device';
const NODE_TYPE_CAMERA = 'camera';

/** Tracks per query page. */
const TRACK_PAGE = 200;

/** A coordinate point. `ts` is the track's primary key, so it is never optional at rest. */
export type TrackPoint = {
  lat: number;
  lng: number;
  /** ISO timestamp of the fix. */
  ts?: string;
  alt?: number;
  speed?: number;
  course?: number;
  /** Why the fix is left out (a rule's name, or `manual`), on a read asking for rejected fixes. */
  rejected?: string;
  /** What a person said of the fix, which overrules the rules. */
  manual?: TrackVerdict;
};

/** A person's verdict on a fix: `reject` leaves it out whatever the rules say, `accept` keeps it. */
export type TrackVerdict = 'reject' | 'accept';

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
  /** Drop spikes and collapse each stay into two points: metres, ms and m/s. */
  still?: { radius?: number; minMs?: number; stillSpeed?: number; maxSpeed?: number };
  /** Read the rejected fixes too, marked `rejected`; `only` reads them alone, a run of them to a segment. */
  rejected?: boolean | 'only';
};

type TrackReadResult = {
  segments: TrackSegment[];
  points: number;
  truncated: boolean;
};

/** A half-open time range `[from, to)`, either end optional. */
type TrackRange = { from?: string; to?: string };

/** The fixes of a time range a verdict is given to: those within `radius` metres of a point, those a person gave a verdict. */
export type TrackSelection = TrackRange & {
  near?: { lat: number; lng: number; radius: number };
  marked?: TrackVerdict;
};

/** Structural view of the core TrackHandle (modules avoid core imports). */
type TrackLikeHandle = {
  appendPoints(points: TrackPoint[]): Promise<number>;
  readPoints(opts?: TrackReadOptions): Promise<TrackReadResult>;
  markPoints(selection: TrackSelection, verdict: TrackVerdict | null): Promise<number>;
  /** Move a time range to the track `to` is open on, for writing. Returns the fixes moved. */
  movePoints(range: TrackRange, to: TrackLikeHandle): Promise<number>;
  close(): Promise<void>;
};

type Node = Awaited<ReturnType<Command['sys']['vfs']['get']>>;
/** Nodes read by path, kept for the next track: a listing reads each device once. */
type NodeCache = Map<string, Promise<Node | undefined>>;

const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The node at `path`, read once per cache, or undefined when it cannot be read. */
const cachedNode = (cmd: Command, nodes: NodeCache, path: string): Promise<Node | undefined> => {
  if (!nodes.has(path)) nodes.set(path, cmd.sys.vfs.get(cmd.access, path).catch(() => undefined));
  return nodes.get(path)!;
};

/** Where the device a track at `path` is an endpoint of would be, `/dev/<device>`: its parent under `/dev`. */
const devicePathOf = (track: string): string | undefined => dirname(dirname(track)) === DEV_PATH ? dirname(track) : undefined;

/** The device a track at `path` is an endpoint of, when it is one's. */
const deviceAbove = async (cmd: Command, path: string, nodes: NodeCache): Promise<Node | undefined> => {
  const parent = devicePathOf(path);
  const node = parent === undefined ? undefined : await cachedNode(cmd, nodes, parent);
  return node?.type === NODE_TYPE_DEVICE ? node : undefined;
};

/**
 * What the track at `path` is called. A device's track is named by its device's label (else its
 * name), a track other than its `position` with its own label (else its name) after that. Any other
 * track is its own `label`, else the label, name or node name of the nearest node above it that is
 * not a track. `nodes` keeps the nodes read, by path, for the next track.
 */
async function trackName(cmd: Command, path: string, track: Node, nodes: NodeCache = new Map()): Promise<string> {
  const own = str(track.attrs.label);
  const device = await deviceAbove(cmd, path, nodes);
  if (device) {
    const label = str(device.attrs.label) ?? basename(dirname(path));
    return basename(path) === POSITION_ENDPOINT ? label : `${label} · ${own ?? basename(path)}`;
  }
  if (own) return own;
  for (let at = dirname(path); at !== '/' && at !== '.'; at = dirname(at)) {
    const node = await cachedNode(cmd, nodes, at);
    if (!node) break;
    if (node.type === NODE_TYPE_TRACK) continue;
    return str(node.attrs.label) ?? str(node.attrs.name) ?? basename(at);
  }
  return basename(path);
}

/** How a track travels: its own `kind`, else its device's `class` when that is a kind (`TravelKind`). */
const travelKind = (track: Record<string, unknown>, device?: Record<string, unknown>): string | undefined =>
  isTravelKind(track.kind) ? track.kind : isTravelKind(device?.class) ? device.class : undefined;

/** How the track at `path` travels: its own `kind`, else its device's `class` when that is a kind. */
export async function trackKind(cmd: Command, path: string, track: Node): Promise<string | undefined> {
  if (isTravelKind(track.attrs.kind)) return track.attrs.kind;
  return travelKind(track.attrs, (await deviceAbove(cmd, path, new Map()))?.attrs);
}

/**
 * Every track within `within` (a `track` node anywhere in its tree), with what the registry says of
 * it. One query finds them and one registry read gives their summaries, so no track is opened
 * however many there are.
 */
export async function listTracks(cmd: Command, within: string = DEV_PATH): Promise<TrackEntry[]> {
  const rows: { path: string; node: Node }[] = [];
  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const page = await cmd.sys.vfs.query(cmd.access, { types: [NODE_TYPE_TRACK], within, after, limit: TRACK_PAGE });
    rows.push(...page.map((row) => ({ path: row.absPath, node: row.node as Node })));
    if (page.length < TRACK_PAGE) break;
    after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
  }
  const summaries = await cmd.sys.vfs.trackSummaries(cmd.access, rows.map((row) => row.node.id));
  const nodes: NodeCache = new Map();

  const tracks = await Promise.all(rows.map(async ({ path, node }): Promise<TrackEntry | undefined> => {
    const summary = summaries.get(node.id);
    if (!summary) return undefined;
    const device = await deviceAbove(cmd, path, nodes);
    const kind = travelKind(node.attrs, device?.attrs);
    return {
      path,
      nodeId: node.id,
      ...(device ? { device: dirname(path) } : {}),
      name: await trackName(cmd, path, node, nodes),
      ...(kind ? { kind } : {}),
      description: str(node.attrs.description),
      ...summary,
    };
  }));
  return tracks.filter((track): track is TrackEntry => track !== undefined).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** The path a target names: a path as it is, a bare name the first holder of that name (`TRACK_HOLDER_ROOTS`). */
const targetPath = async (cmd: Command, target: string): Promise<string> => {
  if (target.includes('/')) return resolve(cmd.cwd, target);
  for (const root of TRACK_HOLDER_ROOTS) {
    if (await cmd.sys.vfs.exists(cmd.access, `${root}/${target}`, { follow: false })) return `${root}/${target}`;
  }
  throw new Error(`${target}: no device or camera of that name (${TRACK_HOLDER_ROOTS.join(', ')})`);
};

/** The node at `path`, not followed, and the path a softlink there points at. */
const nodeAt = async (cmd: Command, path: string): Promise<{ node: Node; target?: string }> => {
  const node = await cmd.sys.vfs.get(cmd.access, path, { follow: false, readlink: true }).catch(() => {
    throw new Error(`${path}: not found`);
  });
  return { node, ...(node.props.softlink ? { target: resolve(dirname(path), node.props.softlink) } : {}) };
};

/** The device the camera at `camera` links (its child softlink `device`), or undefined when it links none. */
export async function cameraDevice(cmd: Command, camera: string): Promise<string | undefined> {
  const link = `${camera}/${CAMERA_DEVICE_LINK}`;
  const node = await cmd.sys.vfs.get(cmd.access, link, { follow: false, readlink: true }).catch(() => undefined);
  return node?.props.softlink ? resolve(dirname(link), node.props.softlink) : undefined;
}

/**
 * The track a target names, and what it is called. A track is itself, and a softlink to one the
 * track it points at; a camera is the track of the device it links (its child softlink `device`);
 * a device, or any other node, is the one track within its tree, a device's `position` when it has
 * more than one. A bare name is looked for in `TRACK_HOLDER_ROOTS`.
 */
export async function trackOf(cmd: Command, target: string): Promise<{ path: string; name: string }> {
  let path = await targetPath(cmd, target);
  let { node, target: linked } = await nodeAt(cmd, path);
  if (linked) {
    path = linked;
    ({ node, target: linked } = await nodeAt(cmd, path));
    if (linked) throw new Error(`${path}: a link to a link`);
  }

  if (node.type === NODE_TYPE_CAMERA) {
    const device = await cameraDevice(cmd, path);
    if (!device) throw new Error(`${path} has no track: it links no device (camera-device)`);
    path = device;
    node = (await nodeAt(cmd, path)).node;
  }
  if (node.type !== NODE_TYPE_TRACK) {
    const found = await cmd.sys.vfs.query(cmd.access, { types: [NODE_TYPE_TRACK], within: path, limit: TRACK_PAGE });
    if (found.length === 0) throw new Error(`${path} has no track`);
    const chosen = found.length === 1 ? found[0] : found.find((row) => row.absPath === `${path}/${POSITION_ENDPOINT}`);
    if (!chosen) throw new Error(`${path} has ${found.length} tracks: name one`);
    path = chosen.absPath;
    node = chosen.node as Node;
  }
  return { path, name: await trackName(cmd, path, node) };
}

/**
 * The device a target names, and its node: its name under `/dev`, its path, or a track of it. A
 * device is what an album and a camera link.
 */
export async function deviceOf(cmd: Command, target: string): Promise<{ path: string; node: Node }> {
  let path = target.includes('/') ? resolve(cmd.cwd, target) : devicePath(target);
  let node = await cmd.sys.vfs.get(cmd.access, path).catch(() => {
    throw new Error(`${path}: no such device`);
  });
  if (node.type === NODE_TYPE_TRACK) {
    const device = await deviceAbove(cmd, path, new Map());
    if (!device) throw new Error(`${path}: a track of no device`);
    path = dirname(path);
    node = device;
  }
  if (node.type !== NODE_TYPE_DEVICE) throw new Error(`${path}: not a device (is ${node.type})`);
  return { path, node };
}

/** Open the track a target names (see `trackOf`). Caller closes. */
export async function openTrack(cmd: Command, target: string, mode: 'r' | 'a' | 'w'): Promise<{ path: string; name: string; handle: TrackLikeHandle }> {
  const track = await trackOf(cmd, target);
  const handle = await cmd.sys.vfs.open(cmd.access, track.path, { mode });
  return { ...track, handle: handle as unknown as TrackLikeHandle };
}

/** A camera linked to a track's device, with what a GPX file may name it by. */
type TrackCamera = { path: string; name: string; make?: string; model?: string; serialNumber?: string };

/**
 * The cameras linked to the device of each of `tracks` (their child softlink `device`), by the
 * track's path: one lookup of the links, one read of the cameras.
 */
export async function trackCameras(cmd: Command, tracks: string[]): Promise<Map<string, TrackCamera[]>> {
  const byTrack = new Map<string, TrackCamera[]>(tracks.map((track) => [track, []]));
  const ofDevice = new Map<string, string[]>();
  for (const track of tracks) {
    const device = devicePathOf(track);
    if (device) ofDevice.set(device, [...ofDevice.get(device) ?? [], track]);
  }
  if (ofDevice.size === 0) return byTrack;
  const links = (await cmd.sys.vfs.findLinks(cmd.access, [...ofDevice.keys()])).filter((link) => basename(link.absPath) === CAMERA_DEVICE_LINK);
  const cameras = await cmd.sys.vfs.getNodesByIds(cmd.access, [...new Set(links.map((link) => link.parentId))]);
  for (const link of links) {
    const camera = cameras.get(link.parentId);
    if (camera?.type !== NODE_TYPE_CAMERA) continue;
    const path = dirname(link.absPath);
    const attrs = camera.attrs as Record<string, unknown>;
    const entry: TrackCamera = {
      path,
      name: str(attrs.name) ?? basename(path),
      ...(str(attrs.make) ? { make: str(attrs.make) } : {}),
      ...(str(attrs.model) ? { model: str(attrs.model) } : {}),
      ...(str(attrs.serialNumber) ? { serialNumber: str(attrs.serialNumber) } : {}),
    };
    for (const track of ofDevice.get(resolve(path, link.target)) ?? []) byTrack.get(track)!.push(entry);
  }
  return byTrack;
}

/** What a GPX file may name a device or a camera by, besides a track's name. */
type GpxNames = { name?: string; make?: string; model?: string; serialNumber?: string };

/**
 * What a GPX file may name each of `tracks` by besides its name: its device's manufacturer and
 * model, and serial number, and the name, make and model, and serial number of each camera linked to
 * the device.
 */
export async function trackNames(cmd: Command, tracks: string[]): Promise<Map<string, GpxNames[]>> {
  const cameras = await trackCameras(cmd, tracks);
  const nodes: NodeCache = new Map();
  return new Map(
    await Promise.all(tracks.map(async (track): Promise<[string, GpxNames[]]> => {
      const device = (await deviceAbove(cmd, track, nodes))?.attrs;
      const own: GpxNames[] = device
        ? [{
          ...(str(device.manufacturer) ? { make: str(device.manufacturer) } : {}),
          ...(str(device.model) ? { model: str(device.model) } : {}),
          ...(str(device.serial) ? { serialNumber: str(device.serial) } : {}),
        }]
        : [];
      return [track, [...own, ...cameras.get(track) ?? []]];
    })),
  );
}

/**
 * Keep a GPX file a track was read from: filed in the track's `routes/`, moved there or with
 * `copy` copied, and linked from the track's `sources/`. A file the track holds already, byte for
 * byte, is not kept twice (`fileSource`). `name` is the name to keep it under, instead of its own.
 * Returns where it is kept.
 */
export async function keepRoute(cmd: Command, trackPath: string, gpxPath: string, sha256: string, opts: { copy?: boolean; name?: string } = {}): Promise<string> {
  const { path } = await fileSource(cmd.sys.vfs, cmd.access, gpxPath, `${trackPath}/${ROUTES_DIR}`, { sha256, ...opts });
  await linkSource(cmd.sys.vfs, cmd.access, trackPath, path);
  return path;
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

/** Lower-case words, space-separated and padded: `Garmin eTrex 30x` and `garmin-etrex-30x` read the same. */
const words = (text: string): string => ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;

/**
 * The tracks a GPX file could have been recorded into: those whose name, or the name, make and
 * model, or serial number their device or a camera linked to it goes by (`names`, from
 * `trackNames`), appears, as whole words, in its creator or one of its names. Labels shorter than
 * three characters are too ambiguous to count.
 */
export function tracksForGpx<T extends { name: string; names?: GpxNames[] }>(tracks: T[], gpx: Pick<Gpx, 'creator' | 'names'>): T[] {
  const said = [gpx.creator, ...gpx.names].filter((text): text is string => Boolean(text)).map(words);
  return tracks.filter((track) => {
    const labels = [track.name, ...(track.names ?? []).flatMap((names) => [names.name ?? '', [names.make, names.model].filter(Boolean).join(' '), names.serialNumber ?? ''])]
      .map(words)
      .filter((label) => label.trim().length >= 3);
    return labels.some((label) => said.some((text) => text.includes(label)));
  });
}

/** How many of the times of `points` the track has no fix at, rejected or not: what appending them adds. */
const newTimes = async (cmd: Command, track: string, points: TrackPoint[]): Promise<number> => {
  const times = [...new Set(points.flatMap((point) => point.ts ? [Date.parse(point.ts)] : []))];
  if (times.length === 0) return 0;
  const first = times.reduce((a, b) => Math.min(a, b));
  const last = times.reduce((a, b) => Math.max(a, b));
  const handle = await cmd.sys.vfs.open(cmd.access, track, { mode: 'r' }) as unknown as TrackLikeHandle;
  let read: TrackReadResult;
  try {
    read = await handle.readPoints({ from: new Date(first).toISOString(), to: new Date(last + 1).toISOString(), rejected: true });
  } finally {
    await handle.close();
  }
  const held = new Set(read.segments.flatMap((segment) => segment.points.flatMap((point) => point.ts ? [Date.parse(point.ts)] : [])));
  return times.filter((time) => !held.has(time)).length;
};

/**
 * Append the timed fixes of a GPX file (`points`, read from `bytes`) to the track at `track`, and
 * answer how many it had no fix at the time of. A device's `position` that core's `tracker` driver
 * keeps takes the file as raw input to its device, as `cat ride.gpx > /dev/<device>` gives it; any
 * other track takes the fixes as they are.
 */
export async function appendGpx(cmd: Command, track: string, bytes: Uint8Array, points: TrackPoint[]): Promise<number> {
  const device = basename(track) === POSITION_ENDPOINT ? devicePathOf(track) : undefined;
  const driver = device && (await cmd.sys.vfs.get(cmd.access, device).catch(() => undefined))?.attrs.driver;
  if (device && driver === TRACKER_DRIVER) {
    const added = await newTimes(cmd, track, points);
    const handle = await cmd.sys.vfs.open(cmd.access, device, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
    return added;
  }
  const handle = await cmd.sys.vfs.open(cmd.access, track, { mode: 'a' }) as unknown as TrackLikeHandle;
  try {
    return await handle.appendPoints(points);
  } finally {
    await handle.close();
  }
}
