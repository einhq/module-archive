import { LOCATIONS_ROOT } from '@archive/paths';
import { parseArgs } from '@ein/client';
import { shq } from '@ein/client';
import type { AttrCondition, ContainerListing, NodeAttrs, NodeId } from '@ein/client';
import type { WithinMatch } from '@ein/client';
import { unlistedIds } from '@ein/client';
import { lowerBound as parseDateBound, taggedPaths, upperBoundExclusive as exclusiveUpperBound } from '@ein/client';
import { resolveSubject, subjectMediaIds } from '@archive/subjects';
import { clusterPoints } from './cluster.ts';
import type { Command } from '@ein/client';
import type { CmdReturn } from '@ein/client';

/**
 * Both modes answer for the whole box and then decide what to send, so the scan
 * is never the page. The cap is only there so a runaway query cannot pull an
 * unbounded result set into memory.
 *
 * Scanning wide is what makes an *ordered* answer possible: a registry that
 * truncates before anything is sorted hands back an arbitrary subset. Geometry
 * is the cheap part; the per-row cost is path resolution, which only the page
 * pays.
 */
const SCAN_LIMIT = 200000;

/**
 * Positions that are not media keep their own marker and are never clustered,
 * so they are the one part of a clustered answer that still costs per row.
 * There are a hundred-odd locations in a corpus and thousands of photos, but the
 * bound has to exist rather than be assumed.
 */
const UNCLUSTERED_LIMIT = 2000;

/** How many text hits a map filter takes. */
const TEXT_FILTER_LIMIT = 500;

/** Largest filtered map answer worth resolving into reusable cluster contents. */
const INLINE_CLUSTER_HIT_LIMIT = 500;

/**
 * The media a set of filters admits, as node ids — or undefined when nothing was
 * filtered.
 *
 * Ids rather than paths because that is what a clustered answer has: a hit is a
 * `<file>/position` node, and `splitByParent` already knows the file above it by
 * id. Comparing on paths would mean resolving one per hit, which is exactly the
 * cost clustering exists to avoid.
 *
 * A person or a location is free — `subjectMediaIds` hands back ids, and so does a container's
 * `members` listing, of which the members it shows are kept: a photo folded under a stack is not
 * drawn on its own. A label or a text query gives paths, so those are resolved, in parallel and
 * bounded: a label set is a listing and text is capped by the search itself.
 */
async function filterIds(
  cmd: Command,
  filters: { person?: string; location?: string; tag?: string; query?: string; under?: string },
  bounds: { north: number; south: number; east: number; west: number },
): Promise<Set<NodeId> | undefined> {
  const sets: Set<NodeId>[] = [];

  const pathsToIds = async (paths: string[]): Promise<Set<NodeId>> => {
    const ids = await Promise.all(paths.map(async (path) => {
      try {
        return (await cmd.sys.vfs.get(cmd.access, path)).id;
      } catch {
        return undefined;
      }
    }));
    return new Set(ids.filter((id): id is NodeId => id !== undefined));
  };

  for (const [kind, raw] of [['person', filters.person], ['location', filters.location]] as const) {
    if (!raw) continue;
    // Ids are all a membership set needs; the paths would be resolved and thrown away.
    sets.push((await subjectMediaIds(cmd, kind, await resolveSubject(cmd, kind, raw))).ids);
  }

  if (filters.tag) sets.push(await pathsToIds([...await taggedPaths(cmd, [filters.tag])]));

  if (filters.under) {
    const result = await cmd.execute(`JSON_OUTPUT=1 members ${shq(filters.under)}`);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${filters.under}: cannot list its members`);
    const listing = JSON.parse(result.stdout) as ContainerListing;
    sets.push(new Set(listing.members.filter((member) => !member.front).map((member) => member.id)));
  }

  if (filters.query) {
    // Scoped to the box: a text search of the whole corpus would be a much
    // larger set to resolve, and everything outside the viewport is discarded
    // by the geometry anyway.
    const { north, south, east, west } = bounds;
    const result = await cmd.execute(
      `JSON_OUTPUT=1 search ${shq(filters.query)} --bbox=${north},${south},${east},${west} -l ${TEXT_FILTER_LIMIT}`,
    );
    let paths: string[] = [];
    if (result.code === 0) {
      try {
        paths = (JSON.parse(result.stdout)?.results ?? []).map((hit: { path?: string }) => hit.path).filter(Boolean);
      } catch {
        paths = [];
      }
    }
    sets.push(await pathsToIds(paths));
  }

  if (sets.length === 0) return undefined;
  // Intersected, like `search` intersects its subjects: two filters are "both",
  // never "either".
  return sets.reduce((intersection, set) => new Set([...intersection].filter((id) => set.has(id))));
}

/**
 * What the media node above a matched `<file>/position` says about itself.
 *
 * The dimensions are here rather than in a second lookup because they arrive in
 * the same node read as the date — and a grid that is told a picture's shape
 * lays it out once, instead of guessing 3:2 and re-justifying every row as the
 * images decode.
 */
type MediaFacts = {
  /** The wall clock: what the `--from`/`--to` window and the day/month/year facets read. */
  takenAt?: string;
  /** The instant: what the ordering and the cursor read. See `search/filters.ts`. */
  takenAtUtc?: string;
  width?: number;
  height?: number;
  angle?: number;
  /** Pixel aspect ratio of that raster; only an anamorphic video carries one. */
  sar?: number;
};

/** A row of the flat (unclustered) answer. */
type FlatHit = MediaFacts & {
  id: NodeId;
  lat: number;
  lng: number;
  paths: string[];
};

/**
 * The media facts for many hits at once, keyed by the *parent* id — the
 * registry matched the `<file>/position` child, and everything worth knowing is
 * on the file above it.
 */
async function readMediaFacts(cmd: Command, parentIds: Iterable<NodeId>): Promise<Map<NodeId, MediaFacts>> {
  const ids = [...new Set(parentIds)];
  const facts = new Map<NodeId, MediaFacts>();
  if (ids.length === 0) return facts;

  const num = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;

  const parents = await cmd.sys.vfs.getNodesByIds<NodeAttrs>(cmd.access, ids);
  for (const [id, node] of parents) {
    const attrs = node.attrs ?? {};
    const takenAt = attrs.takenAt as unknown;
    const takenAtUtc = attrs.takenAtUtc as unknown;
    facts.set(id, {
      ...(typeof takenAt === 'string' ? { takenAt } : {}),
      ...(typeof takenAtUtc === 'string' ? { takenAtUtc } : {}),
      ...(num(attrs.width) !== undefined ? { width: num(attrs.width) } : {}),
      ...(num(attrs.height) !== undefined ? { height: num(attrs.height) } : {}),
      ...(num(attrs.angle) !== undefined ? { angle: num(attrs.angle) } : {}),
      ...(num(attrs.sar) !== undefined ? { sar: num(attrs.sar) } : {}),
    });
  }

  return facts;
}

/**
 * A position's facts, when it is the `position` child of more than one file.
 *
 * The earliest date wins, and the dimensions come from
 * whichever file that was — a hit describes one picture, so its shape and its
 * date have to be the same picture's.
 */
function factsFor(parentIds: NodeId[], facts: Map<NodeId, MediaFacts>): MediaFacts {
  let best: MediaFacts | undefined;
  for (const parentId of parentIds) {
    const candidate = facts.get(parentId);
    if (!candidate) continue;
    if (best === undefined) best = candidate;
    // Compared as instants, not as wall clocks: "earliest" across two files shot in different
    // timezones is a question about when, not about what their clocks said.
    else if (candidate.takenAtUtc !== undefined && (best.takenAtUtc === undefined || candidate.takenAtUtc < best.takenAtUtc)) {
      best = candidate;
    }
  }
  return best ?? {};
}

/**
 * Newest first, undated last, ties broken by id.
 *
 * Total and stable, which is what a cursor needs: two rows can only compare
 * equal if they are the same row, so a page boundary can never repeat or skip
 * one.
 */
function byRecency(a: { takenAtUtc?: string; id: NodeId }, b: { takenAtUtc?: string; id: NodeId }): number {
  if (a.takenAtUtc !== b.takenAtUtc) {
    if (a.takenAtUtc === undefined) return 1;
    if (b.takenAtUtc === undefined) return -1;
    return a.takenAtUtc < b.takenAtUtc ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `<takenAtUtc>,<id>`, the sort key of the last row on a page. */
const cursorOf = (row: { takenAtUtc?: string; id: NodeId }): string => `${row.takenAtUtc ?? ''},${row.id}`;

/**
 * The row a cursor names, as something `byRecency` can be asked about.
 *
 * Split at the last comma: an id never contains one, and a UTC instant never
 * does either, so this survives either half being empty.
 */
function parseCursor(raw: string): { takenAtUtc?: string; id: NodeId } {
  const comma = raw.lastIndexOf(',');
  if (comma < 0) throw new Error(`cannot parse --cursor '${raw}' (expected <takenAtUtc>,<id>)`);
  const takenAtUtc = raw.slice(0, comma);
  return { ...(takenAtUtc === '' ? {} : { takenAtUtc }), id: raw.slice(comma + 1) };
}

/** Whether a date passes the (possibly half-open) window. Undated never does. */
const inWindow = (takenAt: string | undefined, from?: string, to?: string): boolean => {
  if (takenAt === undefined) return false;
  if (from !== undefined && takenAt < from) return false;
  if (to !== undefined && takenAt >= to) return false;
  return true;
};

/**
 * Find positions inside a bounding box (map viewport), resolving each match to
 * the VFS paths of what it belongs to: a media file, or a location.
 *
 *   find-within --north=57.7 --south=57.6 --east=12.0 --west=11.9 [--limit 100]
 *   find-within --north=57.7 --south=57.6 --east=12.0 --west=11.9 --from 2015 --to 2015
 *   find-within --north=57.7 --south=57.6 --east=12.0 --west=11.9 --cell 0.05
 *
 * **A negative edge must be written `--west=-180`, not `--west -180`.**
 * `parseArgs` reads the leading `-` as the start of a new option and leaves the
 * edge as the empty string; the `=` form has no such ambiguity. The guard below
 * is what makes the difference visible — `Number('')` is a perfectly valid `0`,
 * which would silently cut a whole-world query down to the north-east quadrant.
 *
 * Each result carries what its media node knows about itself — `takenAt` and
 * the raster `width`/`height`/`angle`. The registry knows only geometry, so all
 * of it comes from the node *above* the matched `<file>/position`, in one
 * batched read, never a walk per hit.
 *
 * **The answer is ordered and paged**: newest first, undated last, `--limit` a
 * page rather than a truncation, and `--cursor` (the `cursor` of the previous
 * answer) resuming after its last row. The whole box is scanned and sorted
 * before a page is cut, so following the cursor reaches every picture in it and
 * no row lands on two pages — where a registry limit would hand back whichever
 * arbitrary rows the scan happened to reach first.
 *
 * **`--dir asc` pages the other way**, from a `--cursor` towards the present, so
 * a reader who jumped into 2008 can scroll back up out of it instead of being
 * sent to the top. It returns oldest-first, in the direction it walked, and it
 * is the caller — prepending them above what it already has — that reverses
 * them.
 *
 * `--from`/`--to` filter on the date, with the `search` command's vocabulary
 * (`2020`, `2020-05`, `2020-05-01`; `--to` covers the whole bucket).
 *
 * **`--facets` answers with per-day, per-month and per-year counts** for the box
 * instead of its contents — what the adaptive time rail uses. It is
 * the cheapest answer this command has: the dates are read either way to order
 * the box, and nothing is resolved to a path.
 *
 * **`--cell <degrees>` answers with counts instead of contents.** Media hits
 * are bucketed into a grid of that size and reported as `{lat, lng, count}`,
 * which is all a zoomed-out map draws; only a cell holding a single hit carries
 * a path, because that one is drawn as a picture, so a zoomed-out box costs
 * geometry rather than one path resolution per hit. A cluster's contents are
 * asked for again as that one cell, unclustered.
 * `--include-hits` also resolves the members when the filtered answer is at
 * most 500 pictures, allowing an interactive map to reuse its expensive search.
 * `--covers` gives every cell of several pictures one of them as its `cover`, so
 * a map can draw the pile as a picture: one more path per cell, resolved in the
 * same batch as the single ones.
 */
export const findWithin = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['north', 'south', 'east', 'west', 'limit', 'from', 'to', 'cell', 'cursor', 'dir', 'person', 'location', 'tag', 'q', 'under'],
    boolean: ['facets', 'include-hits', 'covers'],
  });

  try {
    const edge = (name: 'north' | 'south' | 'east' | 'west'): number => {
      const raw = flags[name];
      if (raw === undefined || raw.trim() === '') {
        throw new Error(`requires numeric --${name} (write a negative edge as --${name}=-180)`);
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`requires numeric --${name}`);
      return value;
    };

    const bounds = { north: edge('north'), south: edge('south'), east: edge('east'), west: edge('west') };

    let cell: number | undefined;
    if (flags.cell !== undefined) {
      cell = Number(flags.cell);
      if (!Number.isFinite(cell) || cell <= 0) throw new Error(`requires a positive --cell size in degrees`);
    }

    // In cluster mode the answer is the whole box, so a page size means
    // nothing; `--limit` there caps the scan instead.
    const limit = flags.limit !== undefined ? Number(flags.limit) : (cell !== undefined ? SCAN_LIMIT : 100);
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('requires a positive --limit');

    if (flags.cursor !== undefined && cell !== undefined) {
      throw new Error('--cursor pages the flat answer; a clustered one is the whole box at once');
    }
    if (flags.facets && cell !== undefined) {
      throw new Error('--facets counts the flat answer; a clustered one is counts already');
    }

    const dir = flags.dir ?? 'desc';
    if (dir !== 'asc' && dir !== 'desc') throw new Error(`unknown --dir '${flags.dir}' (expected: desc, asc)`);
    if (dir === 'asc' && cell !== undefined) {
      throw new Error('--dir pages the flat answer; a clustered one is the whole box at once');
    }
    // Ascending exists to climb back towards the newest from somewhere in the
    // past, so it is always relative to a row. Without a cursor it would start
    // at the oldest picture in the box, which nothing asks for.
    if (dir === 'asc' && flags.cursor === undefined) {
      throw new Error('--dir asc needs a --cursor to walk up from');
    }

    const from = flags.from !== undefined ? parseDateBound(flags.from) : undefined;
    const to = flags.to !== undefined ? exclusiveUpperBound(flags.to) : undefined;
    if (flags.from !== undefined && from === undefined) {
      throw new Error(`cannot parse --from date '${flags.from}' (expected YYYY, YYYY-MM or YYYY-MM-DD)`);
    }
    if (flags.to !== undefined && to === undefined) {
      throw new Error(`cannot parse --to date '${flags.to}' (expected YYYY, YYYY-MM or YYYY-MM-DD)`);
    }
    const timed = from !== undefined || to !== undefined;

    // Resolved once for the whole box, before any geometry: it is a set of ids,
    // and every hit is then a membership test rather than a lookup.
    const admitted = await filterIds(cmd, { person: flags.person, location: flags.location, tag: flags.tag, query: flags.q, under: flags.under }, bounds);

    const matches = await cmd.sys.vfs.findWithin(cmd.access, bounds, cell !== undefined ? limit : SCAN_LIMIT);

    if (cell !== undefined) {
      await writeClustered(cmd, matches, { cell, limit, from, to, timed, admitted, includeHits: flags['include-hits'], covers: flags.covers });
      return 0;
    }

    await writeFlat(cmd, matches, { limit, from, to, timed, admitted, cursor: flags.cursor, facets: flags.facets, dir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`find-within: ${message}\n`);
    return 1;
  }

  return 0;
};

type Window = {
  from?: string;
  to?: string;
  timed: boolean;
  /**
   * Media allowed through, by file id — what the map's search box resolved to.
   *
   * Undefined means unfiltered, which is not the same as an empty set: a filter
   * that matched nothing must show nothing, not everything.
   */
  admitted?: Set<NodeId>;
};

/** True when a hit's owning file is one the filters admit. */
const admits = (opts: Window, owners: NodeId[]): boolean => !opts.admitted || owners.some((id) => opts.admitted!.has(id));

/** The ids of the locations, so a location's shape can be told from a picture's point by its parent. */
async function locationIds(cmd: Command): Promise<Set<NodeId>> {
  try {
    return new Set((await cmd.sys.vfs.children(cmd.access, LOCATIONS_ROOT)).map((entry) => entry.node.id));
  } catch {
    return new Set();
  }
}

/**
 * What each match *is*, from its parent link alone.
 *
 * Every hit is a `position` child. A location's shape is reported as the location —
 * its id stands in for the position's — and every other `position` is media,
 * the child of the file it belongs to; a position node by any other name is
 * reported as itself. One indexed query answers it for the whole batch, and the
 * paths can then be built for only the rows being sent.
 *
 * The map is a view of the library, so a hit whose files all lie in an unlisted
 * tree (staging) is left out, and so is a position of its own there.
 */
async function splitByParent(cmd: Command, matches: WithinMatch[]): Promise<{
  media: WithinMatch[];
  others: WithinMatch[];
  parents: Map<NodeId, NodeId[]>;
}> {
  const [links, locations] = await Promise.all([
    cmd.sys.vfs.getParentLinksByIds(cmd.access, matches.map((match) => match.id)),
    locationIds(cmd),
  ]);

  const media: WithinMatch[] = [];
  const others: WithinMatch[] = [];
  const parents = new Map<NodeId, NodeId[]>();

  for (const match of matches) {
    const entries = links.get(match.id);
    if (!entries || entries.length === 0) continue;

    const owners = entries.filter((entry) => entry.name === 'position').map((entry) => entry.parentId);
    const location = owners.find((owner) => locations.has(owner));
    if (location !== undefined) {
      others.push({ ...match, id: location });
    } else if (owners.length > 0) {
      media.push(match);
      parents.set(match.id, owners);
    } else {
      others.push(match);
    }
  }

  const hidden = await unlistedIds(cmd.sys.vfs, [...[...parents.values()].flat(), ...others.map((match) => match.id)]);
  if (hidden.size === 0) return { media, others, parents };
  for (const [id, owners] of parents) {
    const listed = owners.filter((owner) => !hidden.has(owner));
    if (listed.length > 0) parents.set(id, listed);
    else parents.delete(id);
  }
  return {
    media: media.filter((match) => parents.has(match.id)),
    others: others.filter((match) => !hidden.has(match.id)),
    parents,
  };
}

/**
 * One row per match, newest first, a page at a time.
 *
 * The whole box is scanned and ordered before a page is cut, so paging is
 * total: every picture in the box is reachable by following the cursor, and no
 * row can appear on two pages. Only the page's rows are resolved to paths —
 * that is the expensive part, and the reason a cluster of 2,400 pictures can be
 * scrolled through 60 at a time instead of being truncated at a round number.
 */
async function writeFlat(
  cmd: Command,
  matches: WithinMatch[],
  opts: Window & { limit: number; cursor?: string; facets?: boolean; dir?: 'asc' | 'desc' },
): Promise<void> {
  const { media, others, parents } = await splitByParent(cmd, matches);
  const facts = await readMediaFacts(cmd, [...parents.values()].flat());

  const rows: (MediaFacts & { match: WithinMatch; id: NodeId })[] = [];

  for (const match of media) {
    const owners = parents.get(match.id) ?? [];
    if (!admits(opts, owners)) continue;
    const found = factsFor(owners, facts);

    // Media with no date at all would otherwise sit inside every window the
    // year slider is dragged to, which reads as a filter that does not work.
    if (opts.timed && !inWindow(found.takenAt, opts.from, opts.to)) continue;
    rows.push({ ...found, match, id: match.id });
  }

  // A location has no date and is not what a year slider is about, so a time bound
  // narrows the media and leaves the locations where they are. Undated, they sort
  // to the end.
  for (const match of others) rows.push({ match, id: match.id });

  rows.sort(byRecency);

  // The histogram is over the same rows the pages are cut from, and it is free:
  // every date in the box was already read to sort it. Answering with counts
  // alone also skips path resolution entirely, which is the expensive half.
  if (opts.facets) {
    await writeFacets(cmd, rows);
    return;
  }

  // `byRecency` is total, so reversing the sorted array is exactly the opposite
  // order — no second comparator to keep in step with the first.
  const ordered = opts.dir === 'asc' ? rows.slice().reverse() : rows;

  const after = opts.cursor === undefined ? ordered : (() => {
    const from = parseCursor(opts.cursor);
    // "After" means after in the direction being walked: further into the past
    // going down, closer to the present going up.
    return ordered.filter((row) => opts.dir === 'asc' ? byRecency(row, from) < 0 : byRecency(row, from) > 0);
  })();

  const page = after.slice(0, opts.limit);
  const resolved = await cmd.sys.vfs.resolveIdEntries(cmd.access, page.map((row) => row.id));

  const results: FlatHit[] = [];
  for (const row of page) {
    const entries = resolved.get(row.id);
    if (!entries || entries.length === 0) continue;

    results.push({
      id: row.id,
      lat: row.match.lat,
      lng: row.match.lng,
      paths: entries.map((entry) => entry.path),
      ...(row.takenAt !== undefined ? { takenAt: row.takenAt } : {}),
      // The cursor is built from the instant, so a caller that pages this list is given it.
      ...(row.takenAtUtc !== undefined ? { takenAtUtc: row.takenAtUtc } : {}),
      ...(row.width !== undefined ? { width: row.width } : {}),
      ...(row.height !== undefined ? { height: row.height } : {}),
      ...(row.angle !== undefined ? { angle: row.angle } : {}),
      ...(row.sar !== undefined ? { sar: row.sar } : {}),
    });
  }

  // The cursor is the last row of the page, not of what was returned: a row
  // that resolves nowhere is dropped after the cut, and the next page still has
  // to start after it.
  const last = page.at(-1);
  const cursor = last !== undefined && after.length > page.length ? cursorOf(last) : null;

  if (cmd.json) {
    await cmd.writeJSON({ results, cursor, total: rows.length });
  } else {
    for (const r of results) {
      await cmd.write(`${r.lat},${r.lng} [${r.id}]${r.takenAt ? ` ${r.takenAt}` : ''}:\n`);
      for (const p of r.paths) {
        await cmd.write(` - ${p}\n`);
      }
    }
    if (cursor !== null) await cmd.write(`(more: --cursor ${cursor})\n`);
  }
}

/**
 * Per-day, per-month and per-year counts for the rows the box holds.
 *
 * Shaped like `timeline-facets`, because the same rail draws both: months
 * ascending as `YYYY-MM`, a year-only date under a month key that is just the
 * year (`1975`, "sometime that year"), years ascending, and `range` the ends of
 * the years.
 *
 * Undated rows are left out rather than bucketed anywhere — a picture with no
 * date has no year, and a location never had one. That means `total` here counts
 * what the rail can reach, which is less than the box holds whenever something
 * in it is undated.
 */
async function writeFacets(cmd: Command, rows: { takenAt?: string }[]): Promise<void> {
  const days = new Map<string, number>();
  const months = new Map<string, number>();
  for (const row of rows) {
    if (row.takenAt === undefined) continue;
    const day = row.takenAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.set(day, (days.get(day) ?? 0) + 1);
    const month = row.takenAt.length >= 7 ? row.takenAt.slice(0, 7) : row.takenAt.slice(0, 4);
    if (!/^\d{4}(-\d{2})?$/.test(month)) continue;
    months.set(month, (months.get(month) ?? 0) + 1);
  }

  const monthList = [...months.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const dayList = [...days.entries()]
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
  };

  if (cmd.json) {
    await cmd.writeJSON(payload);
    return;
  }

  await cmd.writeLn(`total: ${total}`);
  if (payload.range) await cmd.writeLn(`range: ${payload.range.min}-${payload.range.max}`);
  for (const year of yearList) await cmd.writeLn(`  ${year.year}  ${year.count}`);
}

/**
 * The media whose date falls in the window.
 *
 * The store decides it: the files above the hits are asked which of them carry a `takenAt` inside
 * the window, and answer with ids alone, so no node is read for a hit that is only counted. A
 * position under several files is dated by the earliest of them, as `factsFor` dates it in the
 * flat answer, so those few files are read in full.
 */
async function inWindowMedia(cmd: Command, media: WithinMatch[], parents: Map<NodeId, NodeId[]>, opts: Window): Promise<WithinMatch[]> {
  const ownersOf = (match: WithinMatch) => parents.get(match.id) ?? [];
  const shared = media.filter((match) => ownersOf(match).length > 1);
  const where: AttrCondition[] = [
    ...(opts.from !== undefined ? [{ ref: 'takenAt', op: 'gte' as const, value: opts.from }] : []),
    ...(opts.to !== undefined ? [{ ref: 'takenAt', op: 'lt' as const, value: opts.to }] : []),
  ];
  const [dated, facts] = await Promise.all([
    cmd.sys.vfs.aggregate(cmd.access, {
      ids: media.filter((match) => ownersOf(match).length === 1).map((match) => ownersOf(match)[0]),
      where,
      group: [{ column: 'id' }],
    }),
    readMediaFacts(cmd, shared.flatMap(ownersOf)),
  ]);
  const inside = new Set(dated.map((bucket) => bucket.key[0]));
  return media.filter((match) => {
    const owners = ownersOf(match);
    return owners.length === 1 ? inside.has(owners[0]) : inWindow(factsFor(owners, facts).takenAt, opts.from, opts.to);
  });
}

/**
 * Media as grid cells, everything else as itself.
 *
 * Nothing here resolves a path it does not have to: what a hit *is* comes from
 * its parent link — a media position is the child called `position` of the file
 * it belongs to — which one indexed query answers for the whole batch.
 */
async function writeClustered(
  cmd: Command,
  matches: WithinMatch[],
  opts: Window & { cell: number; limit: number; includeHits?: boolean; covers?: boolean },
): Promise<void> {
  const split = await splitByParent(cmd, matches);
  const { others: unclustered, parents: mediaParents } = split;
  let media = split.media;

  // Filtered before anything is bucketed, so a cluster's number counts what is drawn.
  if (opts.admitted) media = media.filter((match) => admits(opts, mediaParents.get(match.id) ?? []));

  // A time bound decides which media is counted, so it is applied before anything is bucketed.
  if (opts.timed) media = await inWindowMedia(cmd, media, mediaParents, opts);

  const clusters = clusterPoints(media, opts.cell);

  // A filtered result small enough to send in full can seed its dialogs from
  // this same search. Large and unfiltered maps preserve the count-only path:
  // resolving thousands of paths is the cost clustering exists to avoid.
  const includeHits = opts.includeHits === true && media.length <= INLINE_CLUSTER_HIT_LIMIT;
  // A cell's cover is its first member: any of them stands for the pile, and choosing by date
  // would read every member's date, which is what counting instead of listing saves.
  const coverOf = (cluster: { memberIds: NodeId[]; singleId?: NodeId }) => opts.covers && cluster.singleId === undefined ? cluster.memberIds[0] : undefined;
  const resolvedIds = includeHits
    ? clusters.flatMap((cluster) => cluster.memberIds)
    : clusters.flatMap((cluster) => cluster.singleId !== undefined ? [cluster.singleId] : coverOf(cluster) !== undefined ? [coverOf(cluster)!] : []);
  // Only the hits sent as content need their facts: a few hundred reads instead of thousands.
  const [resolvedPaths, facts] = await Promise.all([
    cmd.sys.vfs.resolveIdEntries(cmd.access, resolvedIds),
    readMediaFacts(cmd, resolvedIds.flatMap((id) => mediaParents.get(id) ?? [])),
  ]);

  // A media filter is a statement about pictures. Locations carry none, so a
  // filtered map shows only what matched rather than leaving every location pin
  // floating over an empty map.
  const locations = opts.admitted ? [] : unclustered.slice(0, UNCLUSTERED_LIMIT);
  const locationPaths = await cmd.sys.vfs.resolveIdEntries(cmd.access, locations.map((match) => match.id));

  const results: FlatHit[] = [];
  for (const match of locations) {
    const entries = locationPaths.get(match.id);
    if (!entries || entries.length === 0) continue;
    results.push({ id: match.id, lat: match.lat, lng: match.lng, paths: entries.map((entry) => entry.path) });
  }

  const content = (id: NodeId) => {
    const entries = resolvedPaths.get(id) ?? [];
    return {
      id,
      paths: entries.map((entry) => entry.path),
      ...factsFor(mediaParents.get(id) ?? [], facts),
    };
  };

  const rows = clusters.map(({ memberIds, singleId, ...cluster }) => {
    if (includeHits) {
      const hits = memberIds.map(content).filter((hit) => hit.paths.length > 0).sort(byRecency);
      return { ...cluster, hits, ...(hits.length === 1 ? { hit: hits[0] } : hits.length > 1 && opts.covers ? { cover: hits[0] } : {}) };
    }
    if (singleId !== undefined) return { ...cluster, hit: content(singleId) };
    const cover = coverOf({ memberIds, singleId });
    return cover !== undefined ? { ...cluster, cover: content(cover) } : cluster;
  });

  const payload = {
    clusters: rows,
    results,
    total: media.length,
    truncated: matches.length >= opts.limit || unclustered.length > UNCLUSTERED_LIMIT,
  };

  if (cmd.json) {
    await cmd.writeJSON(payload);
  } else {
    for (const cluster of clusters) {
      await cmd.write(`${cluster.lat},${cluster.lng} x${cluster.count} [${cluster.key}]\n`);
    }
    for (const r of results) {
      await cmd.write(`${r.lat},${r.lng} [${r.id}]:\n`);
      for (const p of r.paths) {
        await cmd.write(` - ${p}\n`);
      }
    }
  }
}

findWithin.spec = {
  name: 'find-within',
  effect: 'read' as const,
  description: 'Find positions inside a geographic bounding box: media points and locations',
  args: [],
  flags: [
    { name: 'north', type: 'string' as const, description: 'north edge latitude' },
    { name: 'south', type: 'string' as const, description: 'south edge latitude' },
    { name: 'east', type: 'string' as const, description: 'east edge longitude' },
    { name: 'west', type: 'string' as const, description: 'west edge longitude' },
    { name: 'limit', type: 'string' as const, description: 'page size (default: 100; with --cell, max points scanned, default 200000)' },
    { name: 'cursor', type: 'string' as const, description: "resume after this row, from a previous answer's cursor" },
    { name: 'from', type: 'string' as const, description: 'taken at/after this date (2020, 2020-05, 2020-05-01)' },
    { name: 'to', type: 'string' as const, description: 'taken before this date, exclusive (--to 2000 includes all of 2000)' },
    { name: 'cell', type: 'string' as const, description: 'cluster media into a grid of this many degrees and report counts' },
    { name: 'include-hits', type: 'bool' as const, description: 'with --cell, include members when the filtered answer has at most 500 media' },
    { name: 'covers', type: 'bool' as const, description: 'with --cell, give each cell of several pictures one of them as its cover' },
    { name: 'facets', type: 'bool' as const, description: 'answer with per-day, per-month and per-year counts instead of contents' },
    { name: 'dir', type: 'string' as const, description: 'which way to page from the cursor: desc, asc (default desc, back in time)' },
    { name: 'person', type: 'string' as const, description: 'only media this person is tagged in (slug or path)' },
    { name: 'location', type: 'string' as const, description: 'only media linked to this location (slug or path)' },
    { name: 'tag', type: 'string' as const, description: 'only media carrying this label' },
    { name: 'q', type: 'string' as const, description: 'only media matching this text, searched inside the box' },
    { name: 'under', type: 'path' as const, description: 'only media in this album or folder, as `members` lists it' },
  ],
};
