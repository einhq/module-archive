/**
 * The same calendar day, every year the archive reaches back.
 *
 * The obvious implementation is one aggregate grouped on `takenAt` cut to ten
 * characters. Do not: `takenAt` is the wall clock and is **deliberately not
 * indexed**, so grouping it is a sequential scan
 * of every media row — fine in the fifteen-minute metrics sampler, ruinous on a
 * page somebody opens all day.
 *
 * `takenAtUtc` is indexed (`_taken_utc_idx`), so this asks the store the
 * question it can answer fastest: one `gte`/`lt` range per year, each a tight
 * index scan over a single day, walked newest-first a few years at a time and
 * stopped as soon as enough years have something in them. On an archive whose photographs are
 * mostly recent that is a handful of probes, not one per year of history.
 *
 * The day boundaries are UTC rather than local. A picture taken at half past
 * eleven at night in July is filed under the next day in Stockholm — a real but
 * small error, and the honest alternative costs the index.
 *
 * Nothing in an unlisted tree (staging) is shown or decides a year: this is a view of the library.
 *
 * The other reason to walk rather than scan: `MAX_PROBES`. A single bad capture
 * time — a camera whose clock reset to 1970 — must not turn this into fifty
 * years of empty probes, and walking from the present means the years that were
 * worth having are already in hand when the cap is reached.
 */

import type { AttrCondition, NodeQueryEntry, NodeType } from '@ein/client';
import type { Command } from '@ein/client';
import { unlistedRoots } from '@ein/client';
import type { DatedMedia, DayInHistory } from './api.ts';

const NODE_TYPE_FILE: NodeType = 'file';

/**
 * Ceiling on the years probed, whatever the span says.
 *
 * Generous enough for a lifetime of photographs and cheap enough that hitting
 * it costs milliseconds: each probe is one indexed range over one day.
 */
const MAX_PROBES = 80;

/**
 * Probes asked at once. Every year back to the oldest (`--years all`) is a long walk one at a time;
 * a batch costs about what one probe does, and a walk that stops early asks at most a batch more.
 */
const PROBES_AT_ONCE = 8;

const MS_PER_DAY = 86_400_000;

/**
 * Media, and not the thumbnails and transcodes made from it.
 *
 * `takenAtUtc` is written only by the media pipeline's time resolution
 * (`resolve-time.ts`), so requiring it is what makes this
 * media-only without an OR the query layer does not have — and requiring it is
 * free, since the range conditions imply it anyway.
 */
export const NOT_A_DERIVATIVE: AttrCondition = { ref: 'sourceId', op: 'missing' };

type OnThisDayOptions = {
  /** The calendar day, as `MM-DD`. */
  monthDay: string;
  /** How many years with hits to collect before stopping; `Infinity` for every one. */
  years: number;
  /** How many pictures to keep per year. */
  perYear: number;
};

const utc = (date: string): number => Date.parse(`${date}T00:00:00Z`);

const isRealDate = (date: string): boolean => {
  const ms = utc(date);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
};

const attrString = (attrs: Record<string, unknown>, key: string): string | undefined => {
  const value = attrs[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const attrNumber = (attrs: Record<string, unknown>, key: string): number | undefined => {
  const value = attrs[key];
  return typeof value === 'number' ? value : undefined;
};

/**
 * The first or last capture instant in the archive — one indexed lookup each.
 *
 * `orderBy` excludes rows without the attr, so this cannot be fooled by the
 * undated majority of an archive mid-crawl.
 */
const edgeYear = async (cmd: Command, dir: 'asc' | 'desc', notWithin: string[]): Promise<number | undefined> => {
  const rows = await cmd.sys.vfs.query(cmd.access, {
    types: [NODE_TYPE_FILE],
    where: [NOT_A_DERIVATIVE],
    notWithin,
    orderBy: { ref: 'takenAtUtc', dir },
    limit: 1,
  });

  const value = rows[0]?.sortValue;
  if (!value) return undefined;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
};

/** A query row as the thumbnail strip wants it; `fallback` stands in for an unordered row's instant. */
export const datedMediaOf = (row: NodeQueryEntry, fallback: string): DatedMedia => {
  const attrs = row.node.attrs as Record<string, unknown>;
  return {
    path: row.absPath,
    takenAt: attrString(attrs, 'takenAt'),
    takenAtUtc: row.sortValue ?? fallback,
    mimetype: attrString(attrs, 'mimetype'),
    width: attrNumber(attrs, 'width'),
    height: attrNumber(attrs, 'height'),
    angle: attrNumber(attrs, 'angle'),
    sar: attrNumber(attrs, 'sar'),
  };
};

const mediaOn = async (cmd: Command, date: string, limit: number, notWithin: string[]): Promise<DatedMedia[]> => {
  const nextDay = new Date(utc(date) + MS_PER_DAY).toISOString().slice(0, 10);

  const rows = await cmd.sys.vfs.query(cmd.access, {
    types: [NODE_TYPE_FILE],
    where: [
      { ref: 'takenAtUtc', op: 'gte', value: `${date}T00:00:00Z` },
      { ref: 'takenAtUtc', op: 'lt', value: `${nextDay}T00:00:00Z` },
      NOT_A_DERIVATIVE,
    ],
    notWithin,
    orderBy: { ref: 'takenAtUtc', dir: 'asc' },
    limit,
  });

  return rows.map((row) => datedMediaOf(row, `${date}T00:00:00Z`));
};

export const onThisDay = async (cmd: Command, opts: OnThisDayOptions): Promise<DayInHistory> => {
  const { monthDay } = opts;
  const empty: DayInHistory = { monthDay, years: [] };
  if (opts.years <= 0 || opts.perYear <= 0) return empty;

  const notWithin = [...await unlistedRoots(cmd.sys.vfs)];
  const [newest, oldest] = await Promise.all([edgeYear(cmd, 'desc', notWithin), edgeYear(cmd, 'asc', notWithin)]);
  if (newest === undefined || oldest === undefined) return empty;

  // 29 February in a common year. There is no such day, so there is nothing
  // to ask about — and it does not count against the probe budget either.
  const probed: number[] = [];
  for (let year = newest; year >= oldest && probed.length < MAX_PROBES; year--) if (isRealDate(`${year}-${monthDay}`)) probed.push(year);

  const years: DayInHistory['years'] = [];
  for (let at = 0; at < probed.length && years.length < opts.years; at += PROBES_AT_ONCE) {
    const batch = probed.slice(at, at + PROBES_AT_ONCE);
    const found = await Promise.all(batch.map((year) => mediaOn(cmd, `${year}-${monthDay}`, opts.perYear, notWithin)));
    batch.forEach((year, i) => {
      if (found[i].length > 0) years.push({ year, items: found[i] });
    });
  }

  return { monthDay, years: years.slice(0, opts.years) };
};
