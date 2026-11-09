/**
 * VFS mutation -> location domain fact.
 *
 * What `archive-bridge` applies to the location events on its queue. Three facts, one
 * per thing that can go out of date:
 *
 * - **A location's position** (`<location>/position`) depends on its address, its name
 *   when it has no address, the photos a person linked to it, and whether
 *   someone pinned it by hand. Any of those changing, or the shape being
 *   written, is `location.changed`, and `location-upkeep` re-derives the
 *   location and re-links the photos inside it.
 * - **A photo's location** depends on its GPS point, `<file>/position`. The point
 *   being written is `location.point.changed`, and `location-link-point` links the
 *   photo to the location containing it.
 *
 * - **A track's trips** (`<track>/.trips`) depend on its fixes, on how it travels and in which
 *   timezone (its attrs `kind` and `timezone`, and its device's `class`, which is how it travels
 *   when it has no `kind`), and on its homes. Points appended to a device's track under `/dev` (a
 *   content write), one of those attrs changing, or a home added or taken off (a link in its
 *   `homes/`) is `track.changed`, and `track-trips` derives them again; a device's `class`
 *   changing is `track.changed` for each of its tracks.
 *
 * Rules read fresh state rather than trusting the payload, so a
 * fact is right whichever order messages arrive in. A spurious fact is cheap:
 * both pipelines no-op on an unchanged input.
 *
 * Two things are deliberately *not* facts. A link `location-link-media` made from a
 * shape never announces its location — that is the loop @archive/location/location-link
 * exists to break. And a deleted `<file>/location` cannot be followed: the event
 * names the link, and the link, with the location it pointed at, is gone. A location
 * losing a photo is picked up the next time anything else about it changes.
 */

import { DEV_PATH } from '@ein/paths';
import { LOCATIONS_ROOT } from '@archive/paths';
import type { DomainEvent } from '@ein/client';
import { LOCATION_LINK_NAME, POSITION_CHILD, SHAPE_LINK_SOURCE } from '@archive/location/location-link';

const LOCATION_EVENT_SOURCE = 'archive-bridge';

/** The directory of a track's homes. */
const HOMES_DIR = 'homes';

export const LOCATION_EVENTS = {
  /** Something a location's position or photo set is derived from changed. Subject is the location. */
  locationChanged: 'location.changed',
  /** A photo's GPS point was written. Subject is its `<file>/position` node. */
  pointChanged: 'location.point.changed',
  /** Something a track's trips are derived from changed. Subject is the track. */
  trackChanged: 'track.changed',
} as const;

/**
 * VFS routing keys the bridge binds: locations are `location` nodes, points and
 * shapes are `position` nodes, whose content write is an `updated` with no attr
 * changed.
 */
export const LOCATION_BRIDGE_ROUTING_KEYS = [
  'system.vfs.location.created',
  'system.vfs.location.updated',
  'system.vfs.position.created',
  'system.vfs.position.updated',
  'system.vfs.softlink.created',
  'system.vfs.softlink.deleted',
  'system.vfs.track.updated',
  'system.vfs.device.updated',
];

/**
 * The attrs a location's position is derived from. An update touching none of them
 * is bookkeeping — most often the pipeline's own — and announces nothing.
 */
const LOCATION_INPUT_ATTRS = new Set(['address', 'displayName', 'name', 'locationSource']);

/** The track attrs its trips are derived from. `tripEdits` is not one: `trip-edit` derives them itself. */
const TRACK_TRIP_ATTRS = new Set(['kind', 'timezone']);

/** The device attr its tracks' trips are derived from: how they travel when they have no `kind`. */
const DEVICE_TRIP_ATTR = 'class';

export type VfsEventInput = {
  type: string;
  path: string;
  nodeId: string;
  nodeType: string;
  timestamp: number;
  /** Attr names an `updated` event changed; empty for a content write. */
  changedAttrs?: string[];
};

type LinkSnapshot = { id: string; target?: string; attrs: Record<string, unknown> };

/** Everything a rule needs from the VFS, so the rules stay testable in isolation. */
export type LocationRuleContext = {
  /** The softlink node itself, not followed. */
  getLink(path: string): Promise<LinkSnapshot | undefined>;
  /** Whether a position node holds a point yet. */
  hasPoint(path: string): Promise<boolean>;
  /** The node at `path`, or undefined when there is none. */
  getNode(path: string): Promise<{ type: string } | undefined>;
  /** The tracks among the endpoints of the device at `path`. */
  tracksOf(path: string): Promise<{ path: string; nodeId: string }[]>;
};

type Fact = Omit<DomainEvent, 'id'>;

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A location is a location node directly under the locations root. */
const isLocation = (path: string): boolean => parentOf(path) === LOCATIONS_ROOT;

/** Whether `path` lies under `/dev`, where the devices whose tracks have trips are. */
const inDevices = (path: string): boolean => path.startsWith(`${DEV_PATH}/`);

export async function deriveLocationEvents(event: VfsEventInput, ctx: LocationRuleContext, now: number = Date.now()): Promise<Fact[]> {
  const fact = (type: string, subject: string, nodeId: string | undefined, cause: string): Fact => ({
    type,
    subject,
    ...(nodeId ? { nodeId } : {}),
    time: now,
    source: LOCATION_EVENT_SOURCE,
    data: { cause },
  });

  if (event.nodeType === 'location') {
    if (!isLocation(event.path)) return [];
    if (event.type === 'created') return [fact(LOCATION_EVENTS.locationChanged, event.path, event.nodeId, 'created')];
    if (event.type === 'updated' && event.changedAttrs?.some((name) => LOCATION_INPUT_ATTRS.has(name))) {
      return [fact(LOCATION_EVENTS.locationChanged, event.path, event.nodeId, 'attrs')];
    }
    return [];
  }

  if (event.nodeType === 'position') {
    if (nameOf(event.path) !== POSITION_CHILD) return [];
    const contentWrite = event.type === 'updated' && event.changedAttrs !== undefined && event.changedAttrs.length === 0;
    const owner = parentOf(event.path);

    // The location's own events stand for the location; its shape being written is the one fact
    // its position child adds.
    if (isLocation(owner)) return contentWrite ? [fact(LOCATION_EVENTS.locationChanged, owner, undefined, 'shape')] : [];

    // Writers `ensure` the node and write the point after, so a bare create
    // usually has nothing to place yet; the write that follows is the fact.
    if (event.type === 'created' && await ctx.hasPoint(event.path)) {
      return [fact(LOCATION_EVENTS.pointChanged, event.path, event.nodeId, 'created')];
    }
    if (contentWrite) return [fact(LOCATION_EVENTS.pointChanged, event.path, event.nodeId, 'moved')];
    return [];
  }

  if (event.nodeType === 'track') {
    if (event.type !== 'updated' || !inDevices(event.path) || event.changedAttrs === undefined) return [];
    if (event.changedAttrs.length === 0) return [fact(LOCATION_EVENTS.trackChanged, event.path, event.nodeId, 'points')];
    return event.changedAttrs.some((name) => TRACK_TRIP_ATTRS.has(name)) ? [fact(LOCATION_EVENTS.trackChanged, event.path, event.nodeId, 'attrs')] : [];
  }

  if (event.nodeType === 'device') {
    if (event.type !== 'updated' || parentOf(event.path) !== DEV_PATH || !event.changedAttrs?.includes(DEVICE_TRIP_ATTR)) return [];
    return (await ctx.tracksOf(event.path)).map((track) => fact(LOCATION_EVENTS.trackChanged, track.path, track.nodeId, 'class'));
  }

  // A person's residences are links in a `homes/` too; only a track's are its home bases.
  if (event.nodeType === 'softlink' && (event.type === 'created' || event.type === 'deleted') && nameOf(parentOf(event.path)) === HOMES_DIR) {
    const track = parentOf(parentOf(event.path));
    if (!inDevices(track) || (await ctx.getNode(track))?.type !== 'track') return [];
    return [fact(LOCATION_EVENTS.trackChanged, track, undefined, 'homes')];
  }

  if (event.nodeType === 'softlink' && event.type === 'created' && nameOf(event.path) === LOCATION_LINK_NAME) {
    const link = await ctx.getLink(event.path);
    if (!link?.target || !isLocation(link.target)) return [];
    if (link.attrs.linkSource === SHAPE_LINK_SOURCE) return [];
    return [fact(LOCATION_EVENTS.locationChanged, link.target, undefined, 'photo-linked')];
  }

  return [];
}
