import type { TrackPoint } from '@archive/location/api';
import { trackDistance } from './track-segments.ts';

/** A track whose last fix is younger than this is live: the device is taken to be where it last said. */
export const LIVE_FOR_MS = 4 * 60 * 60 * 1000;

/** Two fixes further apart than this say nothing about how fast the device is going now. */
const SPEED_GAP_MS = 10 * 60 * 1000;

/** Whether a fix taken at `ts` is recent enough at `now` for its track to count as live. */
export function isLive(ts: string | undefined, now: number): boolean {
  if (!ts) return false;
  const at = Date.parse(ts);
  return Number.isFinite(at) && now - at < LIVE_FOR_MS;
}

/**
 * `points` with the fixes of `incoming` that are newer than its last one appended, in time order.
 * A read from the last known fix returns that fix again, and an event can arrive twice; neither
 * adds a point. The same array comes back when nothing is new.
 */
export function appendFixes(points: TrackPoint[], incoming: TrackPoint[]): TrackPoint[] {
  const lastTs = points.at(-1)?.ts;
  const after = lastTs ? Date.parse(lastTs) : -Infinity;
  const fresh = incoming
    .filter((point) => point.ts !== undefined && Date.parse(point.ts) > after)
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
  return fresh.length > 0 ? [...points, ...fresh] : points;
}

/**
 * The device's speed at its last fix, in metres per second: what it reported, else the distance
 * from the fix before over the time between them. Undefined when neither is known.
 */
export function speedOf(points: TrackPoint[]): number | undefined {
  const last = points.at(-1);
  if (!last) return undefined;
  if (typeof last.speed === 'number' && Number.isFinite(last.speed)) return last.speed;

  const previous = points.at(-2);
  if (!previous?.ts || !last.ts) return undefined;
  const ms = Date.parse(last.ts) - Date.parse(previous.ts);
  if (!(ms > 0) || ms > SPEED_GAP_MS) return undefined;

  return trackDistance([{ day: last.ts.slice(0, 10), points: [previous, last] }]) / (ms / 1000);
}

/** A speed in metres per second as `12 km/h`. */
export function formatSpeed(metresPerSecond: number): string {
  return `${Math.round(metresPerSecond * 3.6)} km/h`;
}

/** How long ago a fix was taken: `just now`, `40 s ago`, `12 min ago`, `2 h 5 min ago`. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return minutes % 60 > 0 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min ago` : `${Math.floor(minutes / 60)} h ago`;
}
