/**
 * Shared helpers for the track commands: which track a target names, its name, handle access, the
 * point shape, and the listing of every track.
 *
 * A track is a `track` node anywhere under the archive, such as the history of a device's position.
 * It is what travels: how (`kind`), the timezone its days are cut in, its edits to its trips
 * (`tripEdits`) and its description are its attrs, and its home bases (`homes/`), its trips
 * (`.trips`) and the GPX files it was read from (`routes/`, linked from its `sources/`) are its
 * children. A camera that also records where it was links to its track from its child softlink
 * `track`. What a track is without reading it — point count, span, extent — is the track registry's
 * alone; nothing copies it onto the node.
 */
import { ARCHIVE_PATH } from '@ein/paths';
import { CAMERAS_ROOT } from '@archive/paths';
import type { TrackEntry } from '@archive/location/api';
import { fileSource, linkSource } from '@archive/sources';
import type { Command } from '@ein/client';
import { basename, dirname, resolve } from '@std/path';

/** The child softlink of a camera that names the track it records into. */
export const TRACK_LINK = 'track';
/** The child of a track that holds the GPX files it was read from. */
const ROUTES_DIR = 'routes';
/** Where a bare name, one without a `/`, is looked for: a device, then a camera, of that name. */
const TRACK_HOLDER_ROOTS = [`${ARCHIVE_PATH}/devices`, CAMERAS_ROOT];
/** What a command's track argument takes (`trackOf`), as its spec says it. */
export const TRACK_ARG = "the track's path, or a device or camera that has one, by its path or its name";

const NODE_TYPE_TRACK = 'track';
/** A node whose name says what it is of, not what it is called: a device's `position`, say. */
const NODE_TYPE_ENTITY = 'entity';
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

const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * What the track at `path` is called: its own `label`, else the `label`, `name` or node name of the
 * nearest node above it that is neither a track nor an entity — for a device's position history,
 * the device. `nodes` keeps the nodes read, by path, for the next track.
 */
export async function trackName(cmd: Command, path: string, track: Node, nodes = new Map<string, Promise<Node | undefined>>()): Promise<string> {
  const own = str(track.attrs.label);
  if (own) return own;
  for (let at = dirname(path); at !== '/' && at !== '.'; at = dirname(at)) {
    if (!nodes.has(at)) nodes.set(at, cmd.sys.vfs.get(cmd.access, at).catch(() => undefined));
    const node = await nodes.get(at);
    if (!node) break;
    if (node.type === NODE_TYPE_TRACK || node.type === NODE_TYPE_ENTITY) continue;
    return str(node.attrs.label) ?? str(node.attrs.name) ?? basename(at);
  }
  return basename(path);
}

/**
 * Every track within `within` (a `track` node anywhere in its tree), with what the registry says of
 * it. One query finds them and one registry read gives their summaries, so no track is opened
 * however many there are.
 */
export async function listTracks(cmd: Command, within: string = ARCHIVE_PATH): Promise<TrackEntry[]> {
  const rows: { path: string; node: Node }[] = [];
  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const page = await cmd.sys.vfs.query(cmd.access, { types: [NODE_TYPE_TRACK], within, after, limit: TRACK_PAGE });
    rows.push(...page.map((row) => ({ path: row.absPath, node: row.node as Node })));
    if (page.length < TRACK_PAGE) break;
    after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
  }
  const summaries = await cmd.sys.vfs.trackSummaries(cmd.access, rows.map((row) => row.node.id));
  const nodes = new Map<string, Promise<Node | undefined>>();

  const tracks = await Promise.all(rows.map(async ({ path, node }): Promise<TrackEntry | undefined> => {
    const summary = summaries.get(node.id);
    if (!summary) return undefined;
    return {
      path,
      nodeId: node.id,
      name: await trackName(cmd, path, node, nodes),
      kind: str(node.attrs.kind),
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

/**
 * The track a target names, and what it is called. A track is itself, and a softlink to one the
 * track it points at; a node with a child softlink `track` (a camera) is the track that links to;
 * any other node (a device) is the one track within its tree. A bare name is looked for in
 * `TRACK_HOLDER_ROOTS`.
 */
export async function trackOf(cmd: Command, target: string): Promise<{ path: string; name: string }> {
  let path = await targetPath(cmd, target);
  let { node, target: linked } = await nodeAt(cmd, path);
  if (linked) {
    path = linked;
    ({ node, target: linked } = await nodeAt(cmd, path));
    if (linked) throw new Error(`${path}: a link to a link`);
  }

  if (node.type !== NODE_TYPE_TRACK) {
    const link = `${path}/${TRACK_LINK}`;
    const child = await cmd.sys.vfs.exists(cmd.access, link, { follow: false }) ? await nodeAt(cmd, link) : undefined;
    if (child?.target) {
      path = child.target;
      node = (await nodeAt(cmd, path)).node;
      if (node.type !== NODE_TYPE_TRACK) throw new Error(`${link} points at ${path}, which is not a track (is ${node.type})`);
    } else {
      const found = await cmd.sys.vfs.query(cmd.access, { types: [NODE_TYPE_TRACK], within: path, limit: TRACK_PAGE });
      if (found.length === 0) throw new Error(`${path} has no track`);
      if (found.length > 1) throw new Error(`${path} has ${found.length} tracks: name one`);
      path = found[0].absPath;
      node = found[0].node as Node;
    }
  }
  return { path, name: await trackName(cmd, path, node) };
}

/** Open the track a target names (see `trackOf`). Caller closes. */
export async function openTrack(cmd: Command, target: string, mode: 'r' | 'a' | 'w'): Promise<{ path: string; name: string; handle: TrackLikeHandle }> {
  const track = await trackOf(cmd, target);
  const handle = await cmd.sys.vfs.open(cmd.access, track.path, { mode });
  return { ...track, handle: handle as unknown as TrackLikeHandle };
}

/** A camera that links to a track, with what a GPX file may name it by. */
type TrackCamera = { path: string; name: string; make?: string; model?: string; serialNumber?: string };

/**
 * The cameras that link to each of `tracks` (their child softlink `track`), by the track's path:
 * one lookup of the links, one read of the cameras.
 */
export async function trackCameras(cmd: Command, tracks: string[]): Promise<Map<string, TrackCamera[]>> {
  const byTrack = new Map<string, TrackCamera[]>(tracks.map((track) => [track, []]));
  if (tracks.length === 0) return byTrack;
  const links = (await cmd.sys.vfs.findLinks(cmd.access, tracks)).filter((link) => basename(link.absPath) === TRACK_LINK);
  const cameras = await cmd.sys.vfs.getNodesByIds(cmd.access, [...new Set(links.map((link) => link.parentId))]);
  for (const link of links) {
    const camera = cameras.get(link.parentId);
    if (camera?.type !== NODE_TYPE_CAMERA) continue;
    const path = dirname(link.absPath);
    const attrs = camera.attrs as Record<string, unknown>;
    byTrack.get(resolve(path, link.target))?.push({
      path,
      name: str(attrs.name) ?? basename(path),
      ...(str(attrs.make) ? { make: str(attrs.make) } : {}),
      ...(str(attrs.model) ? { model: str(attrs.model) } : {}),
      ...(str(attrs.serialNumber) ? { serialNumber: str(attrs.serialNumber) } : {}),
    });
  }
  return byTrack;
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

const TRKPT_RE = /<trkpt\b([^>]*)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;

/** What a GPX file says about itself and its fixes. */
type Gpx = {
  /** The `creator` attribute: the program or camera that wrote the file. */
  creator?: string;
  /** The file's own `<name>`, `<desc>` and `<time>`: in `<metadata>` (GPX 1.1) or the root (GPX 1.0). */
  name?: string;
  description?: string;
  time?: string;
  /** Each `<trk>`'s `<name>`, in document order. */
  tracks: string[];
  /** Every `<name>` in it — the file's, its tracks' — in document order. */
  names: string[];
  points: TrackPoint[];
};

/** `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&apos;` as the characters they stand for. */
const unescapeXml = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!);

/** The text of each `<tag>` in `xml`, CDATA or not, trimmed; empty ones left out. */
const texts = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([^<\\]]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'g'))].map((m) => unescapeXml(m[1].trim())).filter(Boolean);

/** A number in the first `<tag>` (with or without a namespace prefix) of a point's body, if any. */
const pointNumber = (body: string, tag: string): number | undefined => {
  const text = body.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]+)</(?:\\w+:)?${tag}>`))?.[1];
  const value = text === undefined ? NaN : Number(text);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Read a GPX document: its `<trkpt>` fixes (lat/lon in either order, optional `<ele>`, `<time>`,
 * and speed in m/s and course in degrees from GPX 1.0 or Garmin's TrackPointExtension), creator, own
 * name, description and time, and names.
 */
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

    const speed = pointNumber(body, 'speed');
    if (speed !== undefined) point.speed = speed;
    const course = pointNumber(body, 'course');
    if (course !== undefined) point.course = course;

    const time = body.match(/<time>([^<]+)<\/time>/);
    if (time) {
      const ts = new Date(time[1]);
      if (!Number.isNaN(ts.getTime())) point.ts = ts.toISOString();
    }

    points.push(point);
  }

  // Names inside a point (`<trkpt><name>`) are waypoint labels, not what wrote the file.
  const outside = xml.replace(TRKPT_RE, '');
  const creator = unescapeXml(xml.match(/<gpx\b[^>]*\bcreator="([^"]*)"/)?.[1]?.trim() ?? '') || undefined;
  const names = texts(outside, 'name');
  // What is left without tracks, routes and waypoints is the file's own: its metadata, or the root's children.
  const own = outside.replace(/<(trk|rte|wpt)\b[\s\S]*?<\/\1>/g, '');
  const tracks = [...outside.matchAll(/<trk\b[^>]*>([\s\S]*?)<\/trk>/g)].flatMap((m) => texts(m[1].replace(/<trkseg\b[\s\S]*?<\/trkseg>/g, ''), 'name').slice(0, 1));

  return { creator, name: texts(own, 'name')[0], description: texts(own, 'desc')[0], time: texts(own, 'time')[0], tracks, names, points };
}

/**
 * The fixes of a GPX file a track takes: those with a time. A track is keyed by time, and the
 * registry gives a point without one the moment it arrives, which for a file is the upload rather
 * than when the track was there; such points are left out. `problem` says why nothing is left.
 */
export function timedPoints(points: TrackPoint[]): { points: TrackPoint[]; untimed: number; problem?: string } {
  const timed = points.filter((point) => point.ts !== undefined);
  const problem = points.length === 0 ? 'no track points found' : timed.length === 0 ? `none of its ${points.length} track points has a time` : undefined;
  return { points: timed, untimed: points.length - timed.length, ...(problem ? { problem } : {}) };
}

/** Lower-case words, space-separated and padded: `Garmin eTrex 30x` and `garmin-etrex-30x` read the same. */
const words = (text: string): string => ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;

/**
 * The tracks a GPX file could have been recorded into: those whose name, or the name, make and
 * model, or serial number of a camera that links to them, appears, as whole words, in its creator or
 * one of its names. Labels shorter than three characters are too ambiguous to count.
 */
export function tracksForGpx<T extends { name: string; cameras?: Omit<TrackCamera, 'path'>[] }>(tracks: T[], gpx: Pick<Gpx, 'creator' | 'names'>): T[] {
  const said = [gpx.creator, ...gpx.names].filter((text): text is string => Boolean(text)).map(words);
  return tracks.filter((track) => {
    const labels = [track.name, ...(track.cameras ?? []).flatMap((camera) => [camera.name, [camera.make, camera.model].filter(Boolean).join(' '), camera.serialNumber ?? ''])]
      .map(words)
      .filter((label) => label.trim().length >= 3);
    return labels.some((label) => said.some((text) => text.includes(label)));
  });
}
