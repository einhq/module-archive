/**
 * The `<file>/location` softlink: which location a photo belongs to.
 *
 * Two kinds share the name. One says what a person meant — the legacy import's
 * links, and any link made by hand. The other is arithmetic: `location-link-media`
 * linking a photo because its GPS point falls inside a location's shape, marked
 * `linkSource: 'shape'`.
 *
 * The marker is what keeps automatic upkeep from feeding itself. A location's media
 * centroid is where its photos are; if photos linked *because* they fall inside
 * the circle counted toward it, the circle would define its own photos and
 * shrink every round, since the radius is a percentile of their spread. So a
 * shape link never feeds a centroid and never re-announces its location, and a
 * person's link is never replaced by one.
 */

import type { Node } from '@ein/client';

export const LOCATION_LINK_NAME = 'location';

/** The `position` child holding a file's GPS fix, or a location's shape. */
export const POSITION_CHILD = 'position';

/**
 * Whether `lat`, `lng` is a place a file can be put: finite, on Earth, and not 0,0 — what a camera,
 * phone or Google writes for a picture it has no fix for, never a place anyone took one.
 */
export const isPlace = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** `attrs.linkSource` on a link `location-link-media` made from a shape. */
export const SHAPE_LINK_SOURCE = 'shape';

export const isShapeLink = (node: Pick<Node, 'attrs'>): boolean => (node.attrs as { linkSource?: unknown }).linkSource === SHAPE_LINK_SOURCE;
