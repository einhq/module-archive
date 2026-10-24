/**
 * VFS mutation -> location domain fact.
 *
 * What `archive-bridge` applies to the location events on its queue. Two facts, one
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

import { LOCATIONS_ROOT } from '@archive/paths';
import type { DomainEvent } from '@ein/client';
import { LOCATION_LINK_NAME, POSITION_CHILD, SHAPE_LINK_SOURCE } from '@archive/location/location-link';

const LOCATION_EVENT_SOURCE = 'archive-bridge';

export const LOCATION_EVENTS = {
  /** Something a location's position or photo set is derived from changed. Subject is the location. */
  locationChanged: 'location.changed',
  /** A photo's GPS point was written. Subject is its `<file>/position` node. */
  pointChanged: 'location.point.changed',
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
];

/**
 * The attrs a location's position is derived from. An update touching none of them
 * is bookkeeping — most often the pipeline's own — and announces nothing.
 */
const LOCATION_INPUT_ATTRS = new Set(['address', 'displayName', 'name', 'locationSource']);

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
};

type Fact = Omit<DomainEvent, 'id'>;

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A location is a location node directly under the locations root. */
const isLocation = (path: string): boolean => parentOf(path) === LOCATIONS_ROOT;

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

  if (event.nodeType === 'softlink' && event.type === 'created' && nameOf(event.path) === LOCATION_LINK_NAME) {
    const link = await ctx.getLink(event.path);
    if (!link?.target || !isLocation(link.target)) return [];
    if (link.attrs.linkSource === SHAPE_LINK_SOURCE) return [];
    return [fact(LOCATION_EVENTS.locationChanged, link.target, undefined, 'photo-linked')];
  }

  return [];
}
