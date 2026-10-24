/**
 * Candidate sources for the global timeline.
 *
 * Every timeline source contributes rows and they are merged. That
 * works because they all order on the same thing — an ISO date string — so one
 * page boundary positions all of them at once.
 *
 * Two things about the store shape the design here:
 *
 * - `LocalNodeVFS.query` answers fewer rows than its limit only when the store
 *   has none left, but a source drops rows of its own (`toEntries`), so one
 *   query need not fill a pull. Hence the refill loop.
 * - The page boundary is a `lte` on the date attr, not a keyset `after`. PG
 *   compares `(sortExpr, n.id)` where only `sortExpr` carries `COLLATE "C"`, so
 *   a cross-source boundary on the id half would rest on glibc agreeing with JS
 *   about ULID order. The date half is byte-ordered on both sides; the tie-break
 *   happens here, in JS, which is what the VFS's own sort does anyway. The cost
 *   is that rows sharing the boundary date are re-read once per page.
 */

import type { AttrCondition, AttrRef, Node, NodeQueryCursor, NodeType } from '@ein/client';
import type { Command } from '@ein/client';
import { unlistedRoots } from '@ein/client';
import { type TimelineEntry } from '@archive/timeline/api';
import { type Direction, isPastCursor, type TimelineCursor } from '@archive/timeline/paging';

export interface TimelineSource {
  readonly name: string;
  /** Up to `n` further entries in descending order, or [] when exhausted. */
  pull(n: number): Promise<TimelineEntry[]>;
}

/** Ceiling on rows one source reads while filling a single page. */
const SOURCE_SCAN_BUDGET = 2000;

type AttrSourceOptions = {
  name: string;
  types: NodeType[];
  /** The attr that dates the node, and orders it. */
  ref: AttrRef;
  /** Extra conditions, AND-ed with the boundary. */
  where?: AttrCondition[];
  /** Which way the page walks. Defaults to `desc`. */
  dir?: Direction;
  /** Everything at or past this date; the strict tie-break is applied in JS. */
  cursor?: TimelineCursor;
  /** Exclusive upper bound from `--at`, applied instead of a cursor. */
  before?: string;
  /** Inclusive lower bound from `--year`, applied alongside either of the above. */
  since?: string;
  /**
   * The attr `since` bounds, when it is not `ref`. A span is in a period when it
   * *ends* inside or after it, so an album that began in the December before
   * still belongs to the January it ran into.
   */
  sinceRef?: AttrRef;
  /**
   * Maps a row to zero or more entries. Returning [] drops the row, which is how
   * a source rejects something the store could not express.
   */
  toEntries: (path: string, node: Node, date: string) => TimelineEntry[];
};

/**
 * A source backed by an indexed attr query.
 *
 * Rows without the ordering attr are excluded by the store, which is exactly
 * right here: an album with no dated media, or a person with no birth date, has
 * no place on a timeline. Nor has anything in an unlisted tree, such as a
 * staging area's suggested albums: the timeline is the library's.
 */
export const attrSource = (cmd: Command, opts: AttrSourceOptions): TimelineSource => {
  const dir = opts.dir ?? 'desc';
  const bounds: AttrCondition[] = [];
  if (opts.before !== undefined) bounds.push({ ref: opts.ref, op: 'lt', value: opts.before });
  else if (opts.cursor) bounds.push({ ref: opts.ref, op: dir === 'desc' ? 'lte' : 'gte', value: opts.cursor.date });
  if (opts.since !== undefined) bounds.push({ ref: opts.sinceRef ?? opts.ref, op: 'gte', value: opts.since });

  const where = [...(opts.where ?? []), ...bounds];

  let after: NodeQueryCursor | undefined;
  let exhausted = false;
  /** Entries pulled but not yet handed out — a refill can overshoot. */
  let buffer: TimelineEntry[] = [];

  const fill = async (n: number): Promise<void> => {
    let scanned = 0;
    const notWithin = [...await unlistedRoots(cmd.sys.vfs)];

    while (!exhausted && buffer.length < n && scanned < SOURCE_SCAN_BUDGET) {
      const rows = await cmd.sys.vfs.query(cmd.access, {
        types: opts.types,
        where,
        notWithin,
        orderBy: { ref: opts.ref, dir },
        after,
        limit: n,
      });

      // Fewer than asked for means the store has no more.
      if (rows.length < n) exhausted = true;
      if (rows.length === 0) return;
      scanned += rows.length;

      const last = rows[rows.length - 1];
      after = { value: last.sortValue, id: last.id };

      for (const row of rows) {
        if (row.sortValue === null) continue;
        for (const entry of opts.toEntries(row.absPath, row.node, row.sortValue)) {
          // Rows sharing the boundary date come back again on every page; the
          // strict comparison is what stops them being emitted twice.
          if (opts.cursor && !isPastCursor(entry, opts.cursor, dir)) continue;
          buffer.push(entry);
        }
      }
    }
  };

  return {
    name: opts.name,
    async pull(n: number) {
      await fill(n);
      const page = buffer.slice(0, n);
      buffer = buffer.slice(page.length);
      return page;
    },
  };
};

/** Wraps an already-materialized, already-sorted list as a source. */
export const listSource = (name: string, entries: TimelineEntry[]): TimelineSource => {
  let offset = 0;
  return {
    name,
    pull(n: number) {
      const page = entries.slice(offset, offset + n);
      offset += page.length;
      return Promise.resolve(page);
    },
  };
};
