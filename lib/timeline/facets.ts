/**
 * timeline-facets — how much the timeline holds, per day, month and year.
 *
 * The adaptive scrubber needs the occupied days, months and years before it can
 * draw itself. Paging the feed to find out would defeat the point, so this
 * answers them in a handful of aggregates.
 *
 * Counts are **not** access-filtered (see NodeVFS.aggregate). They size a
 * control; they are not a listing, and nothing is revealed but a magnitude.
 * What lies in an unlisted tree (staging) is not counted, as the feed does not
 * list it.
 *
 * A separate command from `timeline` because the histogram must not move while
 * the feed under it is being paged.
 */

import { parseArgs } from '@ein/client';
import { shq, unlistedRoots } from '@ein/client';
import type { AttrCondition, AttrRef, NodeType } from '@ein/client';
import type { Command } from '@ein/client';
import type { CmdReturn } from '@ein/client';
import { isTimelineKind, RECURRENCE_MODES, type RecurrenceMode, TIMELINE_KINDS, type TimelineKind } from '@archive/timeline/api';
import { birthdaySource } from './birthdays.ts';
import { anniversarySource } from './partnerships.ts';
import type { TimelineSource } from './sources.ts';
import { listTracks } from '@archive/location/track';

const NODE_TYPE_ALBUM = 'album';
const NODE_TYPE_PERSON = 'person';
const NODE_TYPE_FILE = 'file';
const NODE_TYPE_SOFTLINK = 'softlink';

/** One page of a filtered walk. */
const FILTERED_PAGE = 200;
/** Entries examined before a filtered walk gives up and calls its total a floor. */
const FILTERED_SCAN_LIMIT = 5000;

/**
 * The shared answer shape.
 *
 * Same fields as `search --facets` and `find-within --facets`, because the same
 * rail draws all three.
 */
const writeFacets = async (
  cmd: Command,
  days: Map<string, number>,
  months: Map<string, number>,
  perKind: Map<string, number>,
  truncated: boolean,
): Promise<number> => {
  const dayList = [...days.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const monthList = [...months.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const years = new Map<number, number>();
  for (const month of monthList) {
    const year = Number(month.key.slice(0, 4));
    years.set(year, (years.get(year) ?? 0) + month.count);
  }
  const yearList = [...years.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year);

  const total = yearList.reduce((sum, year) => sum + year.count, 0);

  const payload = {
    total,
    range: yearList.length > 0 ? { min: yearList[0].year, max: yearList[yearList.length - 1].year } : null,
    days: dayList,
    months: monthList,
    years: yearList,
    kinds: [...perKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    /** The walk hit its cap, so `total` is a floor rather than a count. */
    truncated,
  };

  if (cmd.json) {
    await cmd.writeJSON(payload);
    return 0;
  }

  await cmd.writeLn(`total: ${total}${truncated ? '+ (scan limit reached)' : ''}`);
  if (payload.range) await cmd.writeLn(`range: ${payload.range.min}-${payload.range.max}`);
  for (const year of yearList) await cmd.writeLn(`  ${year.year}  ${year.count}`);
  for (const kind of payload.kinds) await cmd.writeLn(`${kind.kind.padEnd(12)} ${kind.count}`);
  return 0;
};

/** `YYYY-MM-DD`. Shorter stored dates stay short rather than gaining precision. */
const DAY_PREFIX = 10;

/** Ceiling on synthesized occurrences counted, so a corpus cannot make this unbounded. */
const RECURRENCE_COUNT_LIMIT = 50000;

type Bucket = { types: NodeType[]; ref: AttrRef; where?: AttrCondition[]; kinds: TimelineKind[] };

const BUCKETS: Bucket[] = [
  { types: [NODE_TYPE_ALBUM], ref: 'timeStart', kinds: ['album', 'auto-album'] },
  { types: [NODE_TYPE_PERSON], ref: 'born', kinds: ['birth'] },
  { types: [NODE_TYPE_PERSON], ref: 'died', kinds: ['death'] },
  {
    types: [NODE_TYPE_FILE],
    ref: 'date',
    where: [
      { ref: 'eventType', op: 'exists' },
      { ref: 'eventType', op: 'ne', value: 'birth' },
      { ref: 'eventType', op: 'ne', value: 'death' },
    ],
    kinds: ['event'],
  },
  // Both ends of a residence, counted separately because they are separate
  // entries in the feed. Only the person-side half of the pair carries these
  // attrs, so nothing is counted twice.
  { types: [NODE_TYPE_SOFTLINK], ref: 'movedIn', kinds: ['move'] },
  { types: [NODE_TYPE_SOFTLINK], ref: 'movedOut', kinds: ['move'] },
];

/**
 * Facets for a *filtered* feed, by walking it.
 *
 * The aggregates below cannot express a filter: "albums holding this person's
 * media" is a reverse lookup, not a store condition, and a birth's title does
 * not exist until it is enriched. So a filtered rail is sized by paging the
 * `timeline` command itself — which keeps one definition of what the filters
 * mean, rather than a second one here that could drift from it.
 *
 * Bounded, and it says so: past the cap the count is a floor.
 */
const walkFiltered = async (
  cmd: Command,
  args: string,
  add: (key: string, count: number, kind: string) => void,
): Promise<boolean> => {
  let cursor: string | null = null;
  let seen = 0;

  while (seen < FILTERED_SCAN_LIMIT) {
    const page: string = `JSON_OUTPUT=1 timeline ${args} --no-cover -l ${FILTERED_PAGE}` + (cursor ? ` --cursor ${shq(cursor)}` : '');
    const result = await cmd.execute(page);
    if (result.code !== 0) break;

    let parsed: { cursor: string | null; entries: { date: string; kind: string }[] };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      break;
    }

    const entries = parsed.entries ?? [];
    if (entries.length === 0) break;
    for (const entry of entries) add(entry.date, 1, entry.kind);
    seen += entries.length;

    cursor = parsed.cursor;
    if (!cursor) return false;
  }

  return seen >= FILTERED_SCAN_LIMIT;
};

export const timelineFacets = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['kind', 'birthdays', 'anniversaries', 'today', 'q', 'person', 'location', 'tag'] });

  const kinds = new Set<TimelineKind>();
  for (const raw of (flags.kind ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!isTimelineKind(value)) {
      await cmd.writeError(`timeline-facets: unknown kind '${value}' (expected: ${TIMELINE_KINDS.join(', ')})\n`);
      return 1;
    }
    kinds.add(value);
  }
  if (kinds.size === 0) { for (const kind of TIMELINE_KINDS) kinds.add(kind); }

  const birthdays = (flags.birthdays ?? 'milestone') as RecurrenceMode;
  if (!RECURRENCE_MODES.includes(birthdays)) {
    await cmd.writeError(`timeline-facets: unknown --birthdays '${flags.birthdays}' (expected: ${RECURRENCE_MODES.join(', ')})\n`);
    return 1;
  }

  const anniversaries = (flags.anniversaries ?? 'milestone') as RecurrenceMode;
  if (!RECURRENCE_MODES.includes(anniversaries)) {
    await cmd.writeError(`timeline-facets: unknown --anniversaries '${flags.anniversaries}' (expected: ${RECURRENCE_MODES.join(', ')})\n`);
    return 1;
  }

  const days = new Map<string, number>();
  const months = new Map<string, number>();
  const perKind = new Map<string, number>();

  const add = (key: string, count: number, kind: string): void => {
    const day = key.slice(0, DAY_PREFIX);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.set(day, (days.get(day) ?? 0) + count);
    // A partial date (`1815`) has no month; it still belongs to its year, so it
    // is bucketed under a month key the UI reads as "sometime that year".
    const month = key.length >= 7 ? key.slice(0, 7) : key.slice(0, 4);
    if (!/^\d{4}/.test(month)) return;
    months.set(month, (months.get(month) ?? 0) + count);
    perKind.set(kind, (perKind.get(kind) ?? 0) + count);
  };

  // A filtered rail is walked, an unfiltered one is aggregated. The aggregate is
  // one query per bucket type whatever the corpus is; the walk is bounded pages.
  const filterArgs = (['q', 'person', 'location', 'tag'] as const)
    .filter((name) => flags[name])
    .map((name) => `--${name} ${shq(flags[name]!)}`)
    .join(' ');

  if (filterArgs) {
    const kindArgs = flags.kind ? ` --kind ${shq(flags.kind)}` : '';
    const recurrenceArgs = ` --birthdays ${birthdays} --anniversaries ${anniversaries}` + (flags.today ? ` --today ${shq(flags.today)}` : '');
    const truncated = await walkFiltered(cmd, `${filterArgs}${kindArgs}${recurrenceArgs}`, add);
    return await writeFacets(cmd, days, months, perKind, truncated);
  }

  const notWithin = [...await unlistedRoots(cmd.sys.vfs)];
  for (const bucket of BUCKETS) {
    if (!bucket.kinds.some((kind) => kinds.has(kind))) continue;

    const buckets = await cmd.sys.vfs.aggregate(cmd.access, {
      types: bucket.types,
      where: bucket.where,
      notWithin,
      group: [{ ref: bucket.ref, prefixLength: DAY_PREFIX }],
    });

    // An album bucket covers two kinds; splitting them would need a per-origin
    // aggregate, and the rail only cares about the total.
    for (const row of buckets) add(row.key[0], row.count, bucket.kinds[0]);
  }

  // A track's span is the track registry's, not an attr, so tracks are counted
  // from their listing — one registry read for all of them.
  if (kinds.has('track')) {
    for (const track of await listTracks(cmd)) if (track.firstTs) add(track.firstTs, 1, 'track');
  }

  // The synthesized kinds have no rows to aggregate, so they are counted by
  // being walked — the same sources the feed itself merges, drained.
  const today = flags.today ?? new Date().toISOString().slice(0, 10);
  const synthetic: [TimelineKind, TimelineSource][] = [];

  if (kinds.has('birthday') && birthdays !== 'none') {
    synthetic.push(['birthday', await birthdaySource(cmd, { mode: birthdays, today })]);
  }
  if (kinds.has('anniversary') && anniversaries !== 'none') {
    synthetic.push(['anniversary', await anniversarySource(cmd, { mode: anniversaries, today })]);
  }

  for (const [kind, source] of synthetic) {
    let counted = 0;
    while (counted < RECURRENCE_COUNT_LIMIT) {
      const page = await source.pull(500);
      if (page.length === 0) break;
      for (const entry of page) add(entry.date, 1, kind);
      counted += page.length;
    }
  }

  return await writeFacets(cmd, days, months, perKind, false);
};

timelineFacets.spec = {
  name: 'timeline-facets',
  effect: 'read' as const,
  description: 'Per-day, per-month and per-year counts for the timeline scrubber',
  args: [],
  flags: [
    { name: 'kind', type: 'string' as const, description: `restrict to these kinds: ${TIMELINE_KINDS.join(', ')}` },
    { name: 'birthdays', type: 'string' as const, description: `which recurring birthdays to count: ${RECURRENCE_MODES.join(', ')} (default milestone)` },
    { name: 'anniversaries', type: 'string' as const, description: `which wedding anniversaries to count: ${RECURRENCE_MODES.join(', ')} (default milestone)` },
    { name: 'today', type: 'string' as const, description: 'override the current date (testing)' },
    { name: 'q', type: 'string' as const, description: 'size the rail for a text-filtered feed' },
    { name: 'person', type: 'string' as const, description: 'size the rail for one person (slug or path)' },
    { name: 'location', type: 'string' as const, description: 'size the rail for one location (slug or path)' },
    { name: 'tag', type: 'string' as const, description: 'size the rail for one label' },
  ],
};
