import type { ScrubberFacets } from '../../lib/timeline-scrubber.ts';

/**
 * The time rail of the Sort stream, from what the page holds rather than a server count: how many
 * groups (or, beside a long open group, how many of its pictures) start in each year, month and
 * day, and which of them a date on the rail lands on. Pure, so it is tested without a page.
 */

/** What the rail reads of a row: when it starts, as an ISO date or instant, as precise as it is known. */
type RailRow = { timeStart?: string };

/**
 * Rows per year, month and day of their start, in one pass. A start known only to a year or a
 * month counts there and no finer; the undated count nowhere.
 */
export function railFacets(rows: readonly RailRow[]): ScrubberFacets {
  const years = new Map<number, number>();
  const months = new Map<string, number>();
  const days = new Map<string, number>();
  for (const row of rows) {
    const start = row.timeStart ?? '';
    if (!/^\d{4}/.test(start)) continue;
    years.set(Number(start.slice(0, 4)), (years.get(Number(start.slice(0, 4))) ?? 0) + 1);
    if (/^\d{4}-\d{2}/.test(start)) months.set(start.slice(0, 7), (months.get(start.slice(0, 7)) ?? 0) + 1);
    if (/^\d{4}-\d{2}-\d{2}/.test(start)) days.set(start.slice(0, 10), (days.get(start.slice(0, 10)) ?? 0) + 1);
  }
  const buckets = (counts: Map<string, number>) => [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
  return {
    years: [...years].map(([year, count]) => ({ year, count })).sort((a, b) => a.year - b.year),
    months: buckets(months),
    days: buckets(days),
  };
}

/**
 * The row of `view` a date from the rail lands on (a truncated ISO date: `YYYY`, `YYYY-MM` or
 * `YYYY-MM-DD`): oldest first, the first row starting on or after it; newest first, the first
 * starting on or before its end. The last dated row when the date is past them all; -1 for a view
 * without dates.
 */
export function seekIndex(view: readonly RailRow[], date: string, ascending: boolean): number {
  let lastDated = -1;
  for (let index = 0; index < view.length; index++) {
    const start = view[index].timeStart;
    if (!start) continue;
    lastDated = index;
    const key = start.slice(0, date.length);
    if (ascending ? key >= date : key <= date) return index;
  }
  return lastDated;
}
