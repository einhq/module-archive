import { bucketKey, bucketLabel, type DateBucket, type DateGranularity } from '@ein/ui/lib';

/** What a dated media list draws, in order: media under their date, or events under a date with no media. */
export type TimelineSection<T, E> =
  | { kind: 'media'; group: DateBucket<T>; events?: E[] }
  | { kind: 'events'; key: string; label: string; events: E[] };

type PlaceOptions = {
  /** The width asked for, used when there is no dated media to take it from. */
  granularity: DateGranularity;
  /** Oldest first; otherwise newest first, as the groups are. */
  ascending?: boolean;
  /** Media before the first group is still to load. */
  hasNewer?: boolean;
  /** Media after the last group is still to load. */
  hasMore?: boolean;
};

/**
 * Put an album's dated events among its media groups.
 *
 * The groups set the width — an album too long for days is headed by month or year — and an
 * event goes under the group of its date. One under a date with no media heads a section of its
 * own, in date order among the groups and before the undated group. Those are placed only within
 * the dates loaded so far, so a page still to come cannot land on the wrong side of one.
 */
export function placeEvents<T, E extends { date: string }>(groups: DateBucket<T>[], events: E[], opts: PlaceOptions): TimelineSection<T, E>[] {
  const { granularity, ascending = false, hasNewer = false, hasMore = false } = opts;
  if (events.length === 0) return groups.map((group) => ({ kind: 'media', group }));

  const dated = groups.filter((group) => group.key !== '');
  const width = dated[0]?.key.length;
  const byKey = new Map<string, E[]>();
  for (const event of events) {
    const key = width ? event.date.slice(0, width) : bucketKey(event.date, granularity);
    byKey.set(key, [...byKey.get(key) ?? [], event]);
  }

  const before = (a: string, b: string) => ascending ? a < b : a > b;
  const first = dated[0]?.key;
  const last = dated.at(-1)?.key;
  const alone = [...byKey.keys()]
    .filter((key) => !dated.some((group) => group.key === key))
    .filter((key) => !(hasNewer && first !== undefined && before(key, first)) && !(hasMore && last !== undefined && before(last, key)))
    .sort((a, b) => before(a, b) ? -1 : 1);

  const out: TimelineSection<T, E>[] = [];
  let next = 0;
  const placeUpTo = (key?: string) => {
    for (; next < alone.length && (key === undefined || before(alone[next], key)); next++) {
      out.push({ kind: 'events', key: alone[next], label: bucketLabel(alone[next]), events: byKey.get(alone[next]) ?? [] });
    }
  };
  for (const group of groups) {
    if (group.key === '') placeUpTo();
    else if (!group.continued) placeUpTo(group.key);
    out.push({ kind: 'media', group, events: group.continued ? undefined : byKey.get(group.key) });
  }
  placeUpTo();
  return out;
}
