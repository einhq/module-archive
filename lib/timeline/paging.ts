/**
 * How the timeline is paged: a feed-unique key per entry, the cursor that marks a page boundary,
 * and the order both directions walk in.
 */

import type { TimelineEntry, TimelineKind } from '@archive/timeline/api';

/**
 * A feed-unique key for an entry.
 *
 * A node id alone is not enough: one person contributes both a birth and a
 * death, and a birthday contributes one entry per year. Ordering ties break on
 * this, so it has to be as stable as the date is.
 */
export const entryKey = (nodeId: string, kind: TimelineKind, suffix?: string | number): string => suffix === undefined ? `${nodeId}#${kind}` : `${nodeId}#${kind}#${suffix}`;

export type TimelineCursor = { date: string; key: string };

/**
 * `<date>,<key>`. Split at the *first* comma: a key is `<ULID>#<kind>[#<year>]`
 * and never contains one, but a date could in principle, and this way the codec
 * survives it.
 */
export const encodeCursor = (entry: TimelineEntry): string => `${entry.date},${entry.key}`;

export const parseCursor = (raw: string): TimelineCursor | undefined => {
  const sep = raw.indexOf(',');
  if (sep < 0) return undefined;
  const date = raw.slice(0, sep);
  const key = raw.slice(sep + 1);
  if (!date || !key) return undefined;
  return { date, key };
};

/**
 * Which way a page walks.
 *
 * `desc` is the feed as it is read — newest first, scrolling back in time. `asc`
 * exists so a feed anchored in 1998 can also grow *upward*, towards the present,
 * as the reader scrolls back up. Both are the same page mechanics with the
 * comparisons flipped.
 */
export const DIRECTIONS = ['desc', 'asc'] as const;
export type Direction = typeof DIRECTIONS[number];

export const isDirection = (value: string): value is Direction => (DIRECTIONS as readonly string[]).includes(value);

/**
 * Feed order, ties broken on the key so that two entries sharing a date always
 * come out in the same sequence — which is what makes "strictly past the cursor"
 * a safe way to resume in either direction.
 */
export const compare = (a: TimelineEntry, b: TimelineEntry, dir: Direction): number => {
  const sign = dir === 'desc' ? 1 : -1;
  if (a.date !== b.date) return (a.date < b.date ? 1 : -1) * sign;
  if (a.key === b.key) return 0;
  return (a.key < b.key ? 1 : -1) * sign;
};

/** True when `entry` sorts strictly after `cursor` in the paging direction. */
export const isPastCursor = (entry: TimelineEntry, cursor: TimelineCursor, dir: Direction): boolean => {
  if (entry.date !== cursor.date) return dir === 'desc' ? entry.date < cursor.date : entry.date > cursor.date;
  return dir === 'desc' ? entry.key < cursor.key : entry.key > cursor.key;
};
