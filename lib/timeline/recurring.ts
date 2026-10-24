/**
 * Things that come round every year, as a timeline source.
 *
 * A birthday and a wedding anniversary are the same walk: something happened on
 * a day in a year, and every later year up to today holds an occurrence of it.
 * There is no node to query and no cursor to keep, so a source of these loads
 * its subjects once — hundreds, not millions — and then walks calendar years
 * out from the page boundary, emitting lazily like any other source. That keeps
 * it inside the same merge and the same page boundary as everything else.
 *
 * Only a date carrying a month *and* a day recurs. A year-only date (`1815`,
 * which much of an imported corpus has) produces nothing at all — there is no
 * day to put an occurrence on, and inventing 1 Jan would be a lie the feed then
 * sorts on.
 */

import { type RecurrenceMode, type TimelineEntry } from '@archive/timeline/api';
import { compare, type Direction, isPastCursor, type TimelineCursor } from '@archive/timeline/paging';
import { isMilestone, yearOf } from './people-dates.ts';
import { listSource, type TimelineSource } from './sources.ts';

/**
 * Whether `YYYY-MM-DD` names a day that exists.
 *
 * The case this is here for is 29 February: a leap-day birthday simply has no
 * occurrence in a common year, and the alternative — sliding it to the 28th or
 * the 1st — is picking a side of an argument the archive has no business
 * having.
 */
export const isRealDate = (date: string): boolean => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
};

/** One subject that comes round every year. */
export type Recurrence = {
  /** `MM-DD` it comes round on. */
  monthDay: string;
  /** The year it happened; the occurrence year minus this is the count. */
  originYear: number;
  /**
   * Last year with an occurrence, inclusive — a death, a partnership that
   * ended, or an assumed span. Without one, a corpus of nineteenth-century
   * ancestors celebrates forever.
   */
  lastYear: number;
  /** Build the entry once the occurrence date and count are known. */
  emit: (date: string, years: number) => TimelineEntry;
};

export type RecurringOptions = {
  mode: RecurrenceMode;
  /** Which way the page walks. Defaults to `desc`. */
  dir?: Direction;
  cursor?: TimelineCursor;
  /** Exclusive upper bound from `--at`. */
  before?: string;
  /** Inclusive lower bound from `--year`. */
  since?: string;
  /** Today, as `YYYY-MM-DD`. Injected so tests are not tied to the wall clock. */
  today: string;
};

/**
 * The occurrences of `items`, newest first, as a source the merge can page.
 *
 * Each `pull` keeps walking years until it has enough or runs out of them.
 */
export const recurringSource = (name: string, items: Recurrence[], opts: RecurringOptions): TimelineSource => {
  if (opts.mode === 'none' || items.length === 0) return listSource(name, []);

  const dir = opts.dir ?? 'desc';
  const thisYear = Number(opts.today.slice(0, 4));
  const bound = opts.before ?? opts.cursor?.date;
  const startYear = bound ? (yearOf(bound) ?? thisYear) : thisYear;
  // Nothing recurs before the first subject started, and nothing is generated
  // past today.
  // A lower bound stops the walk too, rather than generating every year back to
  // the first subject only for `admits` to drop them.
  const earliestYear = Math.max(Math.min(...items.map((item) => item.originYear)), opts.since ? (yearOf(opts.since) ?? 0) : 0);

  let year = dir === 'desc' ? Math.min(startYear, thisYear) : Math.max(startYear, earliestYear);
  let buffer: TimelineEntry[] = [];

  const admits = (entry: TimelineEntry): boolean => {
    if (entry.date > opts.today) return false;
    if (opts.since !== undefined && entry.date < opts.since) return false;
    if (opts.before !== undefined) return entry.date < opts.before;
    if (opts.cursor) return isPastCursor(entry, opts.cursor, dir);
    return true;
  };

  /** The occurrences falling in one calendar year. */
  const yearEntries = (year: number): TimelineEntry[] => {
    const entries: TimelineEntry[] = [];

    for (const item of items) {
      // Count 0 is the thing itself — the birth, the wedding — which its own
      // source already emits; a feed saying both "was born" and "turns 0" on
      // one day says nothing twice.
      const years = year - item.originYear;
      if (years <= 0) continue;
      if (year > Math.min(item.lastYear, thisYear)) continue;
      if (opts.mode === 'milestone' && !isMilestone(years)) continue;

      const date = `${year}-${item.monthDay}`;
      if (!isRealDate(date)) continue;

      entries.push(item.emit(date, years));
    }

    return entries;
  };

  const exhausted = () => dir === 'desc' ? year < earliestYear : year > thisYear;

  return {
    name,
    pull(n: number) {
      while (buffer.length < n && !exhausted()) {
        // Sorted in the paging direction within the year, so the merge never
        // has to look back.
        const batch = yearEntries(year).filter(admits).sort((a, b) => compare(a, b, dir));
        buffer.push(...batch);
        year += dir === 'desc' ? -1 : 1;
      }

      const page = buffer.slice(0, n);
      buffer = buffer.slice(page.length);
      return Promise.resolve(page);
    },
  };
};
