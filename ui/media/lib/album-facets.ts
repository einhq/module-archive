import { type ScrubberFacets } from '../../lib/timeline-scrubber.ts';
/**
 * Time facets for a list already held whole in the browser: counting it here is
 * exact and costs no round trip — and a seek becomes a scroll rather than a
 * refetch.
 */

type DatedItem = { timeStart?: string; modtime?: number };

/** A date as written: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, and whatever follows a day. */
const WRITTEN_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:$|T)/;

/**
 * The item's date at the precision it was written with: `YYYY`, `YYYY-MM` or
 * `YYYY-MM-DD`, or undefined when it has no usable date.
 *
 * `timeStart` is read as written, not parsed into an instant: a wall clock is
 * the day the reader means wherever the browser is, an offset or `Z` names the
 * clock it was read from, and a year-only album stays a year rather than
 * becoming its 1 January. `modtime` is the fallback only: it says when the row
 * was last written, not when the album is of, and a bulk pass rewrites every
 * one at once. It is an instant with no written form, so it is the UTC day.
 */
export function dateKeyOf(item: DatedItem): string | undefined {
  const written = item.timeStart ? WRITTEN_DATE.exec(item.timeStart) : null;
  if (written) return written.slice(1).filter(Boolean).join('-');
  if (item.modtime !== undefined && Number.isFinite(item.modtime)) {
    return new Date(item.modtime).toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * Oldest first by date as written, so the grid is in the order the rail's keys
 * are: a year-only album before that year's months, a month-only one before its
 * days. Items on the same written date keep the order of their instants, and
 * undated ones come first.
 */
export function compareByDate(a: DatedItem, b: DatedItem): number {
  const byKey = (dateKeyOf(a) ?? '').localeCompare(dateKeyOf(b) ?? '');
  return byKey !== 0 ? byKey : instantOf(a) - instantOf(b);
}

const instantOf = (item: DatedItem): number => {
  const stamp = item.timeStart ? Date.parse(item.timeStart) : NaN;
  return Number.isNaN(stamp) ? item.modtime ?? 0 : stamp;
};

/**
 * Where a seek to `date` (a key of any precision) lands in a list sorted by
 * `compareByDate`: the first item inside or past it in the list's direction,
 * or -1 when there is none.
 */
export function indexAtDate(items: readonly DatedItem[], date: string, ascending: boolean): number {
  return items.findIndex((item) => {
    const key = dateKeyOf(item)?.slice(0, date.length);
    if (key === undefined) return false;
    return ascending ? key >= date : key <= date;
  });
}

/**
 * Year, month and day counts over the items, each ascending by key.
 *
 * Undated items are simply absent: the rail is a map of occupied time, and an
 * album with no date occupies none of it. An item dated to a month is in no
 * day, and one dated to a year is counted under a month key that is just the
 * year, which the rail reads as "sometime that year".
 */
export function facetsFromItems(items: readonly DatedItem[]): ScrubberFacets {
  const days = new Map<string, number>();
  const months = new Map<string, number>();
  const years = new Map<number, number>();

  for (const item of items) {
    const key = dateKeyOf(item);
    if (!key) continue;
    if (key.length === 10) days.set(key, (days.get(key) ?? 0) + 1);
    const month = key.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
    const year = Number(key.slice(0, 4));
    years.set(year, (years.get(year) ?? 0) + 1);
  }

  const sorted = <K extends string | number>(map: Map<K, number>): [K, number][] => [...map.entries()].toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));

  return {
    years: sorted(years).map(([year, count]) => ({ year, count })),
    months: sorted(months).map(([key, count]) => ({ key, count })),
    days: sorted(days).map(([key, count]) => ({ key, count })),
  };
}

/**
 * Where each date bucket begins and how far it runs, in grid coordinates.
 *
 * The rail maps a drag onto a scroll offset through these. A bucket's section
 * starts at the row holding its first item and ends where the next bucket's
 * does, so a section spans whole rows even when a bucket begins mid-row —
 * scrolling to a month should put the start of that month on screen, not the
 * card that happens to precede it.
 */
export function sectionsForItems(
  items: readonly DatedItem[],
  keyLength: 7 | 10,
  geometry: { columns: number; cardHeight: number; gap: number; height: number },
): { key: string; offset: number; size: number }[] {
  if (items.length === 0 || geometry.columns <= 0) return [];

  const stride = geometry.cardHeight + geometry.gap;
  const rowTop = (index: number) => Math.floor(index / geometry.columns) * stride;

  const starts: { key: string; offset: number }[] = [];
  let previous: string | undefined;
  for (const [index, item] of items.entries()) {
    const date = dateKeyOf(item);
    if (!date) continue;
    const key = date.slice(0, keyLength);
    if (key === previous) continue;
    previous = key;
    starts.push({ key, offset: rowTop(index) });
  }

  return starts.map((start, i) => ({
    key: start.key,
    offset: start.offset,
    size: (starts[i + 1]?.offset ?? geometry.height) - start.offset,
  }));
}
