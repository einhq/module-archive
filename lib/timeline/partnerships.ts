/**
 * Dated partnerships, and the anniversaries that come round from them.
 *
 * A partnership is an ordinary relation pair — `<a>/partners/<b>` ↔
 * `<b>/partners/<a>`, both halves carrying `attrs.relation` — and the
 * partnership's start lives there rather than on the wedding's event file.
 * That is not a preference, it is the only place it can live:
 *
 *  - **The event names one spouse, never both.** A wedding was written down
 *    under whichever of the two the person entering it was on, so an
 *    anniversary read from event files is missing from the other's page.
 *  - **An event cannot end.** A couple who parted still has their wedding
 *    written down; only `relation.to` says the anniversary stopped coming.
 *  - **Not every partnership has an event.** `person-set-partner --from` dates
 *    one by hand, and nothing writes an event file for it.
 *
 * Both halves of a pair carry identical relation attrs, which is the whole
 * difficulty: a query over `relation.from` returns two rows per couple, so the
 * pair is collapsed after the read. The set is hundreds of rows rather than
 * millions, so there is
 * nothing to page, and an asymmetry stored on one half is one more thing that
 * can drift.
 */

import type { AttrRef, NodeType } from '@ein/client';
import type { Command } from '@ein/client';
import { type TimelineEntry } from '@archive/timeline/api';
import { entryKey } from '@archive/timeline/paging';
import { yearOf } from './people-dates.ts';
import { type Recurrence, type RecurringOptions, recurringSource } from './recurring.ts';
import { listSource, type TimelineSource } from './sources.ts';

const NODE_TYPE_SOFTLINK: NodeType = 'softlink';
const PARTNERS_DIR = 'partners';

/** `attrs.relation.from` — the partnership's start. */
const RELATION_FROM: AttrRef = { path: ['relation', 'from'] };

/** Ceiling on the relation rows read. Hundreds is the real number; this is the guard. */
const PARTNERSHIP_LIMIT = 5000;

/**
 * How long a partnership is assumed to last when nothing says otherwise.
 *
 * The same guard as `ASSUMED_LIFESPAN`, for the same reason and against the
 * same failure: without it an 1840s marriage in an imported genealogy is still
 * having anniversaries today. Past a platinum wedding the archive is almost
 * certainly describing two people who are no longer alive, and a death date
 * ends it sooner whenever one is recorded.
 */
const ASSUMED_PARTNERSHIP = 75;

/** One couple, and when they started. */
type Partnership = {
  /** Node id of the half this was read from; the entry key rests on it. */
  id: string;
  /** `<owner>/partners/<other>` — the half that won the pair. */
  linkPath: string;
  ownerPath: string;
  partnerPath: string;
  /** `married`, `engaged`, or absent for a partnership that says no more. */
  kind?: string;
  /** The start, as stored, possibly partial (`1972`, `1972-05`). */
  from: string;
  /** When it ended, when that is recorded. */
  to?: string;
  year: number;
  /** `MM-DD`, only set when the start carries both. */
  monthDay?: string;
};

/**
 * How a partnership's recurrence is worded, from the `kind` on the relation.
 *
 * An undeclared partnership is "together": the archive knows the two have been
 * a couple since a date and deliberately does not know more than that, and
 * calling that a marriage would be inventing one.
 */
export const partnershipYears = (kind: string | undefined, couple: string, years: number): string => {
  const what = kind === 'married' ? 'married' : kind === 'engaged' ? 'engaged' : 'together';
  return `${couple} — ${years} years ${what}`;
};

/** The person a `partners/` link hangs off: `/people/a/partners/b` -> `/people/a`. */
const partnerOwner = (linkPath: string): string | undefined => {
  const parts = linkPath.split('/');
  if (parts.length < 4 || parts[parts.length - 2] !== PARTNERS_DIR) return undefined;
  return parts.slice(0, -2).join('/');
};

const relationOf = (attrs: Record<string, unknown>): Record<string, unknown> | undefined => {
  const relation = attrs.relation;
  return relation && typeof relation === 'object' ? relation as Record<string, unknown> : undefined;
};

const relationString = (relation: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = relation?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * Every couple whose start date the archive knows, once each.
 *
 * The pair is collapsed on the two people it names rather than on
 * `relation.peerLink`: a half whose peer was renamed still names the same two,
 * and the endpoints are what an anniversary is about. Which half survives is
 * decided by the link path so that the answer does not depend on row order —
 * halves that disagree about the date are a fault for `person-check`, not
 * something to average here.
 */
export const datedPartnerships = async (cmd: Command): Promise<Partnership[]> => {
  // Ordered rather than filtered on `relation.from`, though the order itself is
  // not wanted: a query excludes rows missing its ordering attr, so `orderBy`
  // *is* the "exists" condition — and it is the form that reaches
  // `_relation_from_idx`. As a bare condition the planner has no reason to
  // prefer that index and walks every softlink in the archive instead.
  const rows = await cmd.sys.vfs.query(cmd.access, {
    types: [NODE_TYPE_SOFTLINK],
    orderBy: { ref: RELATION_FROM, dir: 'asc' },
    limit: PARTNERSHIP_LIMIT,
  });

  const byCouple = new Map<string, Partnership>();

  for (const row of rows) {
    // Residence links carry `relation.from` too; only a `partners/` link is a
    // couple, and only a link that still points somewhere names one.
    const ownerPath = partnerOwner(row.absPath);
    const partnerPath = row.node.props.softlink;
    if (!ownerPath || !partnerPath) continue;

    const relation = relationOf(row.node.attrs as Record<string, unknown>);
    const from = relationString(relation, 'from');
    if (!from) continue;

    const year = yearOf(from);
    if (year === undefined) continue;

    const key = [ownerPath, partnerPath].toSorted().join('\0');
    const held = byCouple.get(key);
    if (held && held.linkPath <= row.absPath) continue;

    byCouple.set(key, {
      id: row.id,
      linkPath: row.absPath,
      ownerPath,
      partnerPath,
      kind: relationString(relation, 'kind'),
      from,
      to: relationString(relation, 'to'),
      year,
      monthDay: /^\d{4}-(\d{2}-\d{2})/.exec(from)?.[1],
    });
  }

  return [...byCouple.values()];
};

/**
 * How many person reads are in flight at once while the death dates are
 * fetched. Wide enough to hide the latency, narrow enough to stay a guest on
 * the shared pool.
 */
const DEATH_CONCURRENCY = 12;

/**
 * The death year of everyone a dated partnership names.
 *
 * Read one person at a time rather than through `datedPeople`, which is an attr
 * scan of every person node in the archive on every timeline page: this is at
 * most a couple of hundred targeted reads, and none at all when nothing is dated.
 */
export const partnershipDeaths = async (cmd: Command, partnerships: Partnership[]): Promise<Map<string, number>> => {
  const paths = [...new Set(partnerships.flatMap((couple) => [couple.ownerPath, couple.partnerPath]))];
  const deaths = new Map<string, number>();
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const path = paths[next++];
      if (path === undefined) return;
      try {
        const died = (await cmd.sys.vfs.get(cmd.access, path)).attrs.died;
        const year = typeof died === 'string' ? yearOf(died) : undefined;
        if (year !== undefined) deaths.set(path, year);
      } catch {
        // gone or unreadable: no death date to bound anything with
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(DEATH_CONCURRENCY, paths.length) }, worker));
  return deaths;
};

/**
 * The last year a partnership has an anniversary: when it ended, when the first
 * of the two died, or an assumed span — whichever comes first.
 */
export const partnershipLastYear = (partnership: Partnership, diedYear: (path: string) => number | undefined): number => {
  const ends = [
    partnership.to ? yearOf(partnership.to) : undefined,
    diedYear(partnership.ownerPath),
    diedYear(partnership.partnerPath),
    partnership.year + ASSUMED_PARTNERSHIP,
  ].filter((year): year is number => year !== undefined);

  return Math.min(...ends);
};

/** A partnership as something that comes round, or nothing when no day does. */
const partnershipRecurrence = (
  partnership: Partnership,
  diedYear: (path: string) => number | undefined,
  emit: (partnership: Partnership, date: string, years: number) => TimelineEntry,
): Recurrence[] => {
  if (!partnership.monthDay) return [];

  return [{
    monthDay: partnership.monthDay,
    originYear: partnership.year,
    lastYear: partnershipLastYear(partnership, diedYear),
    emit: (date, years) => emit(partnership, date, years),
  }];
};

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * Wedding anniversaries as a timeline source.
 *
 * The entry is about the couple, so it names both and carries both in `people`;
 * it *points* at the half whose link was read, because a couple has no page and
 * a person does. Names are not read here — that would be two lookups per
 * partnership in the corpus rather than per entry on the page — so the title is
 * composed in enrichment, from the paths this leaves in `people`.
 */
export const anniversarySource = async (cmd: Command, opts: RecurringOptions): Promise<TimelineSource> => {
  if (opts.mode === 'none') return listSource('anniversary', []);

  const partnerships = await datedPartnerships(cmd);
  if (partnerships.length === 0) return listSource('anniversary', []);
  const deaths = await partnershipDeaths(cmd, partnerships);

  const items = partnerships.flatMap((partnership) =>
    partnershipRecurrence(partnership, (path) => deaths.get(path), (couple, date, years) => ({
      kind: 'anniversary',
      key: entryKey(couple.id, 'anniversary', date.slice(0, 4)),
      date,
      path: couple.ownerPath,
      // Replaced in enrichment, where both names can be read. The basenames are
      // a legible fallback rather than an empty card.
      title: partnershipYears(couple.kind, `${basename(couple.ownerPath)} and ${basename(couple.partnerPath)}`, years),
      ownerPath: couple.ownerPath,
      people: [couple.ownerPath, couple.partnerPath],
      eventType: couple.kind ?? 'partner',
      years,
    }))
  );

  return recurringSource('anniversary', items, opts);
};
