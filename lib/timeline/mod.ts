/**
 * timeline — one chronological feed of everything that happened, newest first.
 *
 * Albums, births, deaths, birthdays, wedding anniversaries, life events and
 * tracks live in different node types under different attr names, so there is
 * no single query that answers "what happened". Instead each is an ordered
 * source and they are merged here. That works because they all sort on the same thing — an ISO date string
 * — which means one page boundary positions every source at once.
 *
 * Media is deliberately absent: a photo is not a happening, an album is. The
 * feed stays short enough to read, and photos are one click away inside it.
 *
 * See `sources.ts` for why the boundary is a `lte` rather than a keyset cursor,
 * and `enrich.ts` for the reads that are bounded to the emitted page.
 */

import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { parseArgs } from '@ein/client';
import { shq } from '@ein/client';
import type { AttrCondition, Node } from '@ein/client';
import type { Command } from '@ein/client';
import type { CmdReturn } from '@ein/client';
import type { SearchGroupsResponse } from '@ein/api';
import { upperBoundExclusive as exclusiveUpperBound } from '@ein/client';
import { birthdaySource } from './birthdays.ts';
import { enrichPage } from './enrich.ts';
import { isTimelineKind, RECURRENCE_MODES, type RecurrenceMode, TIMELINE_KINDS, type TimelineEntry, type TimelineKind } from '@archive/timeline/api';
import { compare, type Direction, DIRECTIONS, encodeCursor, entryKey, isDirection, isPastCursor, parseCursor, type TimelineCursor } from '@archive/timeline/paging';
import { anniversarySource } from './partnerships.ts';
import { attrSource, listSource, type TimelineSource } from './sources.ts';
import { listTracks } from '@archive/location/track';

const NODE_TYPE_ALBUM = 'album';
const NODE_TYPE_PERSON = 'person';
const NODE_TYPE_FILE = 'file';
const NODE_TYPE_SOFTLINK = 'softlink';

const AUTO_ORIGIN = 'auto';
const EVENTS_DIR = 'events';
const HOMES_DIR = 'homes';
/** The flat projection of a residence span. */
const MOVED_IN_ATTR = 'movedIn';
const MOVED_OUT_ATTR = 'movedOut';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/** How many entries a source buffers at a time inside the merge. */
const BATCH = MAX_LIMIT;

/**
 * Ceiling on entries examined while filling one filtered page.
 *
 * A filter that matches nothing must stop rather than walk the whole feed back
 * to 1815. Past this, the answer is "no more within reach" rather than "no
 * more".
 */
const FILTER_SCAN_LIMIT = 2000;

const basename = (path: string): string => path.split('/').pop() ?? path;
const attrString = (node: Node, key: string): string | undefined => {
  const value = (node.attrs as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const displayName = (node: Node, path: string): string => attrString(node, 'name') ?? basename(path);

/** Year difference, when both dates carry one. */
const yearsBetween = (from: string, to: string): number | undefined => {
  const a = /^(\d{4})/.exec(from);
  const b = /^(\d{4})/.exec(to);
  if (!a || !b) return undefined;
  const years = Number(b[1]) - Number(a[1]);
  return years >= 0 ? years : undefined;
};

/**
 * The owner an event hangs off: `<owner>/events/<slug>`.
 *
 * Owners are people, but also albums and locations — the importer put stories on
 * all three — so this stays a path operation rather than assuming /people.
 */
const eventOwner = (path: string): string | undefined => {
  const parts = path.split('/');
  if (parts.length < 4 || parts[parts.length - 2] !== EVENTS_DIR) return undefined;
  return parts.slice(0, -2).join('/');
};

/** Who a residence link belongs to: `/people/anna/homes/backen` -> `/people/anna`. */
const homeOwner = (path: string): string | undefined => {
  const parts = path.split('/');
  if (parts.length < 4 || parts[parts.length - 2] !== HOMES_DIR) return undefined;
  return parts.slice(0, -2).join('/');
};

type SourceOpts = { dir: Direction; cursor?: TimelineCursor; before?: string; since?: string };

const albumSource = (cmd: Command, kinds: Set<TimelineKind>, opts: SourceOpts): TimelineSource =>
  attrSource(cmd, {
    name: 'album',
    types: [NODE_TYPE_ALBUM],
    ref: 'timeStart',
    ...opts,
    sinceRef: 'timeEnd',
    toEntries: (path, node, date) => {
      // Curated and machine-made albums are separate kinds so either can be
      // filtered out; both are ordered by the span album-span wrote.
      const kind: TimelineKind = attrString(node, 'origin') === AUTO_ORIGIN ? 'auto-album' : 'album';
      if (!kinds.has(kind)) return [];

      const count = (node.attrs as Record<string, unknown>).mediaCount;
      return [{
        kind,
        key: entryKey(node.id, kind),
        date,
        endDate: attrString(node, 'timeEnd'),
        path,
        title: displayName(node, path),
        count: typeof count === 'number' ? count : undefined,
      }];
    },
  });

const personSource = (cmd: Command, kind: 'birth' | 'death', opts: SourceOpts): TimelineSource =>
  attrSource(cmd, {
    name: kind,
    types: [NODE_TYPE_PERSON],
    ref: kind === 'birth' ? 'born' : 'died',
    ...opts,
    toEntries: (path, node, date) => {
      const name = displayName(node, path);
      const born = attrString(node, 'born');
      // "aged 87" only when both ends are known; a bare year on each is enough.
      const age = kind === 'death' && born ? yearsBetween(born, date) : undefined;

      return [{
        kind,
        key: entryKey(node.id, kind),
        date,
        path,
        title: kind === 'birth' ? `${name} was born` : age !== undefined ? `${name} died, aged ${age}` : `${name} died`,
        ownerPath: path,
        people: [path],
        age,
      }];
    },
  });

/**
 * Life events other than birth and death.
 *
 * Those two are excluded because the person node already carries them, is
 * indexed, and covers people who have no event file at all — so taking them from
 * here as well would double every one of them. Their bodies are not lost: the
 * enrichment reads them back onto the person's entry.
 */
const eventSource = (cmd: Command, opts: SourceOpts): TimelineSource => {
  const where: AttrCondition[] = [
    { ref: 'eventType', op: 'exists' },
    { ref: 'eventType', op: 'ne', value: 'birth' },
    { ref: 'eventType', op: 'ne', value: 'death' },
  ];

  return attrSource(cmd, {
    name: 'event',
    types: [NODE_TYPE_FILE],
    ref: 'date',
    where,
    ...opts,
    toEntries: (path, node, date) => {
      const owner = eventOwner(path);
      const eventType = attrString(node, 'eventType');
      return [{
        kind: 'event',
        key: entryKey(node.id, 'event'),
        date,
        path,
        // Marriage and engagement get composed titles during enrichment, where
        // the partner can be looked up. Everything else has only its own name.
        title: displayName(node, path),
        ownerPath: owner,
        people: owner ? [owner] : undefined,
        eventType,
      }];
    },
  });
};

/**
 * Somebody moving in, or somebody moving out.
 *
 * A residence is a span and a feed is moments, so one relation yields up to two
 * entries — which is why this is two sources rather than one: each end pages on
 * its own attr, and the merge puts them back in order.
 *
 * The query reads the *person-side* half of the pair (`<person>/homes/<location>`),
 * which is the only half carrying the flat span; the location-side half is the same
 * fact written twice and would double every move.
 *
 * The entry points at the location, because "where" is what a move is about and it
 * is what someone reading the feed wants to open. Both names are needed for the
 * title and neither is in the link, so the title is composed during enrichment.
 */
const moveSource = (cmd: Command, end: 'in' | 'out', opts: SourceOpts): TimelineSource =>
  attrSource(cmd, {
    name: `move-${end}`,
    types: [NODE_TYPE_SOFTLINK],
    ref: end === 'in' ? MOVED_IN_ATTR : MOVED_OUT_ATTR,
    ...opts,
    toEntries: (path, node, date) => {
      const person = homeOwner(path);
      const location = node.props.softlink;
      // A link that is not under a `homes/` directory, or points nowhere: the
      // attr says residence but the shape does not, so it is not one.
      if (!person || !location) return [];

      return [{
        kind: 'move',
        key: entryKey(node.id, 'move', end),
        date,
        path: location,
        // Replaced in enrichment, where both names can be read. The basenames
        // are a legible fallback rather than an empty card.
        title: end === 'in' ? `${basename(person)} moved to ${basename(location)}` : `${basename(person)} left ${basename(location)}`,
        ownerPath: person,
        people: [person],
        eventType: end === 'in' ? 'moved-in' : 'moved-out',
      }];
    },
  });

/**
 * Every device's track, dated by its first fix. The span is the track registry's, not the
 * node's, so the tracks are listed (`listTracks`, one registry read for all of them) and paged
 * here — a device has one track, so there are few. Like a spanning album, a track is in a
 * period when it ends inside or after it.
 */
const trackSource = async (cmd: Command, opts: SourceOpts): Promise<TimelineSource> => {
  const entries = (await listTracks(cmd)).flatMap((track): TimelineEntry[] => {
    if (!track.firstTs) return [];
    if (opts.before !== undefined && track.firstTs >= opts.before) return [];
    if (opts.since !== undefined && (track.lastTs ?? track.firstTs) < opts.since) return [];

    const entry: TimelineEntry = {
      kind: 'track',
      key: entryKey(track.nodeId, 'track'),
      date: track.firstTs,
      endDate: track.lastTs,
      path: track.path,
      title: track.name,
      points: track.points,
    };
    return !opts.cursor || isPastCursor(entry, opts.cursor, opts.dir) ? [entry] : [];
  });

  return listSource('track', entries.sort((a, b) => compare(a, b, opts.dir)));
};

/**
 * K-way merge over the sources.
 *
 * Each source keeps one page buffered; the largest head wins and is replaced
 * from its own source. A source that returns an empty pull is finished — a short
 * pull is not, because a source stops at its scan budget.
 *
 * A merger rather than a function because a filtered feed asks for more than one
 * batch to fill one page, and the per-source buffers have to survive between
 * them: they hold entries that were pulled but not yet consumed, and starting a
 * fresh merge would drop exactly those.
 */
const createMerger = (sources: TimelineSource[], dir: Direction) => {
  const heads = new Map<TimelineSource, TimelineEntry[]>();
  const done = new Set<TimelineSource>();

  const head = async (source: TimelineSource): Promise<TimelineEntry | undefined> => {
    let buffer = heads.get(source);
    if ((!buffer || buffer.length === 0) && !done.has(source)) {
      buffer = await source.pull(BATCH);
      if (buffer.length === 0) done.add(source);
      heads.set(source, buffer);
    }
    return buffer?.[0];
  };

  return {
    /** Up to `n` further entries in feed order, or [] when every source is spent. */
    async pull(n: number): Promise<TimelineEntry[]> {
      const page: TimelineEntry[] = [];
      while (page.length < n) {
        let best: TimelineSource | undefined;
        let bestEntry: TimelineEntry | undefined;

        for (const source of sources) {
          const candidate = await head(source);
          if (!candidate) continue;
          if (!bestEntry || compare(candidate, bestEntry, dir) < 0) {
            best = source;
            bestEntry = candidate;
          }
        }

        if (!best || !bestEntry) break;
        heads.get(best)!.shift();
        page.push(bestEntry);
      }
      return page;
    },
  };
};

/** How many albums `unheldIn` checks at once. */
const HELD_CONCURRENCY = 8;

/**
 * The spanning albums in `entries` that hold nothing taken inside `[since, before)`.
 *
 * A span says when an album's first and last pictures were taken, not that any
 * fall in between: an album of scanned negatives from 1954 to 1980 would otherwise
 * be in every one of those 26 years. An album that lies wholly inside the year
 * needs no check, and those are most of them; the few that reach past it are each
 * asked whether they hold anything from the year.
 */
const unheldIn = async (cmd: Command, entries: TimelineEntry[], since: string, before: string): Promise<Set<string>> => {
  const spanning = entries.filter((entry) => (entry.kind === 'album' || entry.kind === 'auto-album') && (entry.date < since || (entry.endDate ?? entry.date) >= before));
  const unheld = new Set<string>();
  const year = since.slice(0, 4);

  for (let i = 0; i < spanning.length; i += HELD_CONCURRENCY) {
    await Promise.all(
      spanning.slice(i, i + HELD_CONCURRENCY).map(async (entry) => {
        const result = await cmd.execute(`JSON_OUTPUT=1 search --under ${shq(entry.path)} --from ${year} --to ${year} -l 1`);
        if (result.code !== 0) return;
        try {
          if ((JSON.parse(result.stdout)?.results ?? []).length === 0) unheld.add(entry.key);
        } catch {
          // An answer that does not parse proves nothing; keep the album.
        }
      }),
    );
  }

  return unheld;
};

/**
 * The albums holding a subject's or a label's media, as `search --group-by album`
 * answers it. One subshell per filter, not per entry.
 */
const containersFor = async (cmd: Command, flag: string, value: string): Promise<Set<string>> => {
  const result = await cmd.execute(`JSON_OUTPUT=1 search ${flag} ${shq(value)} --group-by album`);
  if (result.code !== 0) return new Set();
  try {
    const parsed = JSON.parse(result.stdout) as SearchGroupsResponse;
    return new Set((parsed?.groups ?? []).map((group) => group.path).filter(Boolean));
  } catch {
    return new Set();
  }
};

export const timeline = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['limit', 'kind', 'at', 'year', 'cursor', 'birthdays', 'anniversaries', 'today', 'dir', 'q', 'person', 'location', 'tag'],
    boolean: ['no-cover'],
    alias: { l: 'limit' },
  });

  const dir = (flags.dir ?? 'desc') as Direction;
  if (!isDirection(dir)) {
    await cmd.writeError(`timeline: unknown --dir '${flags.dir}' (expected: ${DIRECTIONS.join(', ')})\n`);
    return 1;
  }

  const limit = Math.min(flags.limit !== undefined ? Number(flags.limit) : DEFAULT_LIMIT, MAX_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) {
    await cmd.writeError(`timeline: invalid --limit '${flags.limit}'\n`);
    return 1;
  }

  const kinds = new Set<TimelineKind>();
  for (const raw of (flags.kind ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!isTimelineKind(value)) {
      await cmd.writeError(`timeline: unknown kind '${value}' (expected: ${TIMELINE_KINDS.join(', ')})\n`);
      return 1;
    }
    kinds.add(value);
  }
  if (kinds.size === 0) { for (const kind of TIMELINE_KINDS) kinds.add(kind); }

  const birthdays = (flags.birthdays ?? 'milestone') as RecurrenceMode;
  if (!RECURRENCE_MODES.includes(birthdays)) {
    await cmd.writeError(`timeline: unknown --birthdays '${flags.birthdays}' (expected: ${RECURRENCE_MODES.join(', ')})\n`);
    return 1;
  }

  const anniversaries = (flags.anniversaries ?? 'milestone') as RecurrenceMode;
  if (!RECURRENCE_MODES.includes(anniversaries)) {
    await cmd.writeError(`timeline: unknown --anniversaries '${flags.anniversaries}' (expected: ${RECURRENCE_MODES.join(', ')})\n`);
    return 1;
  }

  // `--at 1998-06` lands *in* June 1998 rather than just before it — the whole
  // named period is included, which is what dragging a scrubber to a month
  // means. Internally that is an exclusive upper bound of 1998-07.
  let before: string | undefined;
  if (flags.at !== undefined) {
    before = exclusiveUpperBound(flags.at);
    if (before === undefined) {
      await cmd.writeError(`timeline: cannot parse --at date '${flags.at}'\n`);
      return 1;
    }
  }

  // `--year 1998` is `--at 1998` with a floor: the feed ends where the year does
  // instead of running on into 1997. A span — an album, a track — is a candidate
  // in every year it touches, so one that began in the December before is still
  // in; a spanning album then stays only if it holds media from the year (`unheldIn`).
  let since: string | undefined;
  if (flags.year !== undefined) {
    if (!/^\d{4}$/.test(flags.year)) {
      await cmd.writeError(`timeline: --year takes a four-digit year, not '${flags.year}'\n`);
      return 1;
    }
    if (flags.at !== undefined) {
      await cmd.writeError('timeline: --year and --at both say where the feed starts; pass one\n');
      return 1;
    }
    if (dir === 'asc') {
      // Walking up from a cursor drops the upper bound, so it would climb out of
      // the year; a year is small enough to read top to bottom.
      await cmd.writeError('timeline: --year pages downward only\n');
      return 1;
    }
    since = flags.year;
    before = exclusiveUpperBound(flags.year);
  }

  let cursor: TimelineCursor | undefined;
  if (flags.cursor !== undefined) {
    cursor = parseCursor(flags.cursor);
    if (cursor === undefined) {
      await cmd.writeError(`timeline: malformed --cursor '${flags.cursor}'\n`);
      return 1;
    }
  }

  if (dir === 'asc' && !cursor) {
    await cmd.writeError('timeline: --dir asc needs a --cursor to walk up from\n');
    return 1;
  }

  // A cursor already encodes where to resume, so `--at` only applies to the
  // first page of an anchored feed.
  const opts: SourceOpts = cursor ? { dir, cursor, since } : { dir, before, since };
  const today = flags.today ?? new Date().toISOString().slice(0, 10);

  // ===== Filters =====
  //
  // A subject filter has two halves, because an entry refers to a subject in two
  // different ways. A birth, a death, a move or an event *is about* a person, and
  // says so in `ownerPath` / `people`. An album merely *contains* them, which is a
  // reverse lookup — resolved once here, into a set of album paths.
  const text = flags.q?.trim().toLowerCase();
  const person = flags.person ? (flags.person.startsWith('/') ? flags.person : `${PEOPLE_ROOT}/${flags.person}`) : undefined;
  const location = flags.location ? (flags.location.startsWith('/') ? flags.location : `${LOCATIONS_ROOT}/${flags.location}`) : undefined;
  const tag = flags.tag;

  // A year drops the spanning albums that hold nothing from it, so it refills
  // like any other filter.
  const filtering = Boolean(text || person || location || tag || since);

  const personContainers = person ? await containersFor(cmd, '--subject', `person:${person}`) : undefined;
  const locationContainers = location ? await containersFor(cmd, '--subject', `location:${location}`) : undefined;
  const tagContainers = tag ? await containersFor(cmd, '--tag', tag) : undefined;

  const matches = (entry: TimelineEntry): boolean => {
    if (text) {
      const haystack = `${entry.title} ${entry.description ?? ''}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    if (person && !(entry.ownerPath === person || entry.people?.includes(person) || personContainers?.has(entry.path))) return false;
    // A move is *about* its location through `path` — the one entry kind whose
    // subject is the location itself rather than something that happened there.
    const atLocation = entry.location === location || entry.ownerPath === location || (entry.kind === 'move' && entry.path === location);
    if (location && !(atLocation || locationContainers?.has(entry.path))) return false;
    // A label lives on files, so nothing here is tagged directly — only the
    // albums holding tagged media can match.
    if (tag && !tagContainers?.has(entry.path)) return false;
    return true;
  };

  const sources: TimelineSource[] = [];
  if (kinds.has('album') || kinds.has('auto-album')) sources.push(albumSource(cmd, kinds, opts));
  if (kinds.has('birth')) sources.push(personSource(cmd, 'birth', opts));
  if (kinds.has('death')) sources.push(personSource(cmd, 'death', opts));
  if (kinds.has('event')) sources.push(eventSource(cmd, opts));
  if (kinds.has('move')) {
    sources.push(moveSource(cmd, 'in', opts));
    sources.push(moveSource(cmd, 'out', opts));
  }
  if (kinds.has('track')) sources.push(await trackSource(cmd, opts));
  if (kinds.has('birthday')) sources.push(await birthdaySource(cmd, { mode: birthdays, today, ...opts }));
  if (kinds.has('anniversary')) sources.push(await anniversarySource(cmd, { mode: anniversaries, today, ...opts }));

  const merger = createMerger(sources, dir);

  // ===== Fill the page =====
  //
  // Unfiltered this is one merge of `limit`. Filtered it is a refill loop, and
  // the filter runs *after* enrichment rather than before: a birth, a death or a
  // move has no title until enrich composes one, and the people an event is
  // about are read there too. So a batch is merged, enriched and then sieved,
  // and the loop goes back for more until the page is full.
  const entries: TimelineEntry[] = [];
  let scanned = 0;
  let last: TimelineEntry | undefined;

  while (entries.length < limit) {
    const batch = await merger.pull(limit);
    if (batch.length === 0) break;
    scanned += batch.length;

    await enrichPage(cmd, batch, { covers: !flags['no-cover'] });
    const unheld = since !== undefined && before !== undefined ? await unheldIn(cmd, batch, since, before) : undefined;

    for (const entry of batch) {
      if (entries.length >= limit) break;
      // Tracked whether or not it survives the filter: the cursor resumes after
      // the last entry *examined*, not the last one kept, or the next page would
      // re-walk everything the filter dropped.
      last = entry;
      if (matches(entry) && !unheld?.has(entry.key)) entries.push(entry);
    }

    if (!filtering || scanned >= FILTER_SCAN_LIMIT) break;
  }

  // A short page means the feed ran out within reach, so there is nothing to
  // resume from. Filtered, `last` is where the scan stopped rather than the last
  // row shown.
  const next = entries.length === limit && last ? encodeCursor(last) : null;

  // Entries come back in the direction they were walked. `--dir asc` therefore
  // reads oldest-first, and it is the caller — which is prepending them above
  // what it already has — that puts them back into feed order.

  if (cmd.json) {
    await cmd.writeJSON({ cursor: next, entries });
    return 0;
  }

  for (const entry of entries) {
    const date = entry.exactDate ?? entry.date;
    const span = entry.endDate && entry.endDate.slice(0, 10) !== date.slice(0, 10) ? ` .. ${entry.endDate.slice(0, 10)}` : '';
    await cmd.writeLn(`${date.slice(0, 10).padEnd(10)}${span.padEnd(14)} ${entry.kind.padEnd(10)} ${entry.title}`);
    if (entry.description) await cmd.writeLn(`             ${entry.description.split('\n')[0]}`);
  }
  return 0;
};

timeline.spec = {
  name: 'timeline',
  effect: 'read' as const,
  description: 'Chronological feed of albums, life events, birthdays and tracks, newest first',
  args: [],
  flags: [
    { name: 'limit', type: 'number' as const, description: `entries per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
    { name: 'kind', type: 'string' as const, description: `restrict to these kinds: ${TIMELINE_KINDS.join(', ')}` },
    { name: 'at', type: 'string' as const, description: 'start the feed at this date instead of now (YYYY[-MM[-DD]], the whole period included)' },
    { name: 'year', type: 'string' as const, description: 'only this year (YYYY): albums holding media taken in it, tracks and everything else dated in it' },
    { name: 'cursor', type: 'string' as const, description: 'resume token from a previous page' },
    { name: 'dir', type: 'string' as const, description: `which way to page from the cursor: ${DIRECTIONS.join(', ')} (default desc, back in time)` },
    { name: 'birthdays', type: 'string' as const, description: `which recurring birthdays to show: ${RECURRENCE_MODES.join(', ')} (default milestone)` },
    { name: 'anniversaries', type: 'string' as const, description: `which wedding anniversaries to show: ${RECURRENCE_MODES.join(', ')} (default milestone)` },
    { name: 'q', type: 'string' as const, description: 'only entries whose title or description contains this text' },
    { name: 'person', type: 'string' as const, description: 'only entries about, or holding media of, this person (slug or path)' },
    { name: 'location', type: 'string' as const, description: 'only entries at, or holding media from, this location (slug or path)' },
    { name: 'tag', type: 'string' as const, description: 'only albums holding media with this label' },
    { name: 'no-cover', type: 'bool' as const, description: 'skip cover lookups' },
    { name: 'today', type: 'string' as const, description: 'override the current date (testing)' },
  ],
};
