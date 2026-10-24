/**
 * Pure segmentation of media into auto-album candidates. No VFS or IO — the bin
 * builds `ClusterItem[]` from a capture-time-ordered VFS scan (plus a GPS and a
 * people lookup) and calls `clusterMedia`, so all of this is unit-testable in the
 * fast tier.
 *
 * Two rules decide every boundary between consecutive items:
 *
 *   1. A time gap larger than `gapMs` always cuts. Distinct happenings are
 *      separated by time, and nothing else is allowed to overrule that.
 *   2. Anything else cuts only if the *boundary score* falls below
 *      `boundaryThreshold` — the same weighted `combineScores` used for cluster
 *      cohesion, over the time gap, the distance, and the people in frame.
 *
 * Distance is evidence, not a verdict: a wedding that moves church -> restaurant
 * is one happening, and the same faces a minute later is stronger evidence than
 * the move.
 *
 * Four guards keep bad coordinates from deciding anything (see `boundaryDecision`):
 * the comparison is between *window centroids* rather than adjacent points, the
 * move must be **confirmed** by more than one item at the new location, it must
 * be **physically plausible**, and it must be **one-way** — neither window may
 * also hold the other side's location, which is what a phone flickering between
 * a good fix and a stale one looks like. A failed guard means the readings are
 * noise, which makes location unknown rather than dissimilar, so `combineScores`
 * drops it instead of scoring it 0.
 *
 * A third rule, the adaptive cut, finds a pause that is long for its neighbourhood: a gap of at
 * least 20 minutes that is 17 times the geometric mean of the gaps around it ends a part, even
 * well under `gapMs`, so a dense burst of shots before lunch is not one part with the burst after.
 * The gaps around it are those of the same run of items, which a pause over `gapMs` ends, so no
 * rule here looks past such a pause: what lies beyond it never changes a cut before it.
 *
 * A person's edits come before every rule: a boundary they cut is cut, and one inside a run they
 * joined is not (`ClusterOptions.cut`, `keep`).
 *
 * Those rules produce *parts*: a morning, an afternoon, an evening. A second
 * level, `rollupClusters`, decides which parts are one album — a week away from
 * home is one trip, and a day at home is one day — without touching the rules
 * above, and `mergeHomeDays` joins a few days at home that share something. See their doc comments.
 */

import { combineScores, haversineMeters, jaccard, locationSimilarity, temporalSimilarity } from './scoring.ts';
import type { AlbumScores } from '@archive/media/api';

export type ClusterItem = {
  /** Canonical media path. */
  path: string;
  /** The file's node id, which orders items taken at the same instant. */
  id?: string;
  /** The camera, for telling one shot from another taken a second later by someone else. */
  device?: string;
  /** Capture time in epoch ms. */
  timeMs: number;
  lat?: number;
  lng?: number;
  /** Person node ids recognised in this media, if any are known yet. */
  persons?: string[];
  /** The pipeline has finished with this file — see the bin's readiness rules. */
  ready?: boolean;
  /**
   * Local calendar day, `YYYY-MM-DD`, read off the wall clock the photographer
   * saw (`takenAt`), when known. `timeMs` is the instant, and the UTC date of an
   * instant is the wrong day for an evening in another time zone.
   */
  day?: string;
};

type ClusterOptions = {
  /** Max time gap (ms) inside one album; a larger gap always cuts. */
  gapMs: number;
  /** Distance (m) between window centroids that counts as a change of location. */
  splitMeters: number;
  /**
   * Speed (km/h) above which a jump is read as a bad fix rather than travel, so
   * the location signal is dropped for that boundary instead of counted.
   * Deliberately above cruising flight speed: the test is for *impossible*
   * readings, and a train or a plane is a real move that should be free to split.
   */
  maxSpeedKmh?: number;
  /** Geotagged items that must agree on the new location before a move is believed. */
  minConfirm?: number;
  /** Boundary score below which the pair is cut. */
  boundaryThreshold?: number;
  /** Items on each side of a boundary that form its comparison window. */
  windowItems?: number;
  /** …extended to at least this much time on each side, when items are sparse. */
  windowMs?: number;
  /** Half-life (ms) for temporal similarity. */
  timeHalfLifeMs?: number;
  /** Characteristic radius (m) for location similarity. Defaults to `splitMeters`. */
  locationScaleM?: number;
  /** Cut where a pause is long for its neighbourhood (the adaptive cut). */
  adaptive?: boolean;
  /** Boundaries a person cut, by the index of the item after them: always cut. */
  cut?: ReadonlySet<number>;
  /** Boundaries inside a run a person joined, by the index of the item after them: never cut. */
  keep?: ReadonlySet<number>;
};

export type Cluster = {
  items: ClusterItem[];
  /** ISO time of the earliest item. */
  timeStart: string;
  /** ISO time of the latest item. */
  timeEnd: string;
  /** Mean lat/lng of geotagged members, if any. */
  centroid?: { lat: number; lng: number };
  scores: AlbumScores;
  /** False when any member is still waiting on the crawl. */
  ready: boolean;
  /** Distinct local days the members fall on. */
  days: number;
  /** The level-1 parts this was rolled up from; absent on a part itself. */
  parts?: Cluster[];
  /** Far from the usual location; absent when that could not be told. See `rollupClusters`. */
  away?: boolean;
  /** Two or more parts on two or more days, all away from the usual location. */
  kind?: 'trip';
  /** Days at home joined by `mergeHomeDays`. */
  merged?: boolean;
};

const DEFAULT_MAX_SPEED_KMH = 1000;
const DEFAULT_MIN_CONFIRM = 2;
const DEFAULT_BOUNDARY_THRESHOLD = 0.5;
const DEFAULT_WINDOW_ITEMS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
/** Distance from the usual location beyond which a part counts as away. */
const DEFAULT_AWAY_METERS = 30_000;
/** Largest gap between two consecutive away parts of one stay: a night, and a day without photos. */
const DEFAULT_STAY_GAP_MS = 48 * 60 * 60 * 1000;
/** Two same-day casts sharing at least this much of the smaller one are the same happening. */
const DEFAULT_DAY_PEOPLE_FLOOR = 0.2;
/** Grid cell (degrees) for finding the usual location; ~5.5 km of latitude. */
const DEFAULT_USUAL_LOCATION_CELL_DEG = 0.05;
/** The adaptive cut: the shortest pause it cuts at, the gaps either side it compares with, and how much longer than them. */
const ADAPTIVE_MIN_GAP_MS = 20 * 60 * 1000;
const ADAPTIVE_WINDOW = 10;
const ADAPTIVE_LOG_FACTOR = Math.log(17);
/** A gap counts as at least a second, so a burst at one instant does not make every pause look endless. */
const ADAPTIVE_FLOOR_MS = 1000;
/** A stay longer than this many local days is split at its longest pause. */
const STAY_CAP_DAYS = 21;
/** Members this close in time, from one camera (or both from none), are one shot. */
const SHOT_GAP_MS = 10 * 1000;
/** What a year's usual day is rounded down to, so a few more photos do not move it. */
const BASELINE_LADDER = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

type Geo = { lat: number; lng: number };

/** Items in the order every rule reads them: by instant, then by node id, so equal instants never reorder. */
export const compareItems = (a: ClusterItem, b: ClusterItem): number => a.timeMs - b.timeMs || (a.id ?? a.path).localeCompare(b.id ?? b.path);

/** The local day of an item: its wall-clock day when known, else the UTC date of the instant. */
export const dayOf = (item: ClusterItem): string => item.day ?? new Date(item.timeMs).toISOString().slice(0, 10);

/** How many distinct local days a run of items falls on. */
const countDays = (items: ClusterItem[]): number => new Set(items.map(dayOf)).size;

const hasGeo = (i: ClusterItem): boolean => i.lat !== undefined && i.lng !== undefined;

/** Mean position of the geotagged items in a slice, or undefined if none are. */
const centroidOf = (items: ClusterItem[]): Geo | undefined => {
  const geo = items.filter(hasGeo);
  if (geo.length === 0) return undefined;
  return {
    lat: geo.reduce((s, i) => s + (i.lat as number), 0) / geo.length,
    lng: geo.reduce((s, i) => s + (i.lng as number), 0) / geo.length,
  };
};

/** Every person id appearing in a slice. */
const personsOf = (items: ClusterItem[]): string[] => {
  const out = new Set<string>();
  for (const i of items) for (const p of i.persons ?? []) out.add(p);
  return [...out];
};

/**
 * The `windowItems` items ending at `end` (inclusive), extended backwards to
 * cover `windowMs` when the items are sparse, and never reaching back past
 * `floor` — the current cluster's own start, so a window cannot see across a
 * boundary that has already been cut.
 */
const trailingWindow = (items: ClusterItem[], end: number, floor: number, opts: Required<Pick<ClusterOptions, 'windowItems' | 'windowMs'>>): ClusterItem[] => {
  let start = end;
  while (start > floor && (end - start + 1 < opts.windowItems || items[end].timeMs - items[start - 1].timeMs <= opts.windowMs)) start--;
  return items.slice(start, end + 1);
};

/**
 * The mirror of `trailingWindow`, starting at `start`. It stops at a gap larger
 * than `gapMs`, which is a boundary rule 1 will cut anyway — looking past it
 * would let a different happening vouch for this one.
 */
const leadingWindow = (items: ClusterItem[], start: number, opts: Required<Pick<ClusterOptions, 'windowItems' | 'windowMs'>> & { gapMs: number }): ClusterItem[] => {
  let end = start;
  while (end + 1 < items.length) {
    if (items[end + 1].timeMs - items[end].timeMs > opts.gapMs) break;
    if (end - start + 1 >= opts.windowItems && items[end + 1].timeMs - items[start].timeMs > opts.windowMs) break;
    end++;
  }
  return items.slice(start, end + 1);
};

/** Implied speed in km/h between two points separated by `gapMs` milliseconds. */
const impliedSpeedKmh = (meters: number, gapMs: number): number => {
  const hours = Math.max(gapMs, 1000) / 3_600_000;
  return meters / 1000 / hours;
};

type BoundaryDecision = {
  cut: boolean;
  /** The per-signal evidence, for tests and for `--verbose`. */
  scores: AlbumScores;
  reason: 'time-gap' | 'low-score' | 'keep';
};

/**
 * Should the run of items be cut between `index - 1` and `index`?
 *
 * `floor` is the index the current cluster started at, so the trailing window
 * never reads across an earlier cut.
 */
export const boundaryDecision = (items: ClusterItem[], index: number, floor: number, opts: ClusterOptions): BoundaryDecision => {
  const prev = items[index - 1];
  const item = items[index];
  const timeGap = item.timeMs - prev.timeMs;

  // Rule 1: time is the one signal allowed to decide on its own.
  if (timeGap > opts.gapMs) return { cut: true, scores: {}, reason: 'time-gap' };

  const win = {
    windowItems: opts.windowItems ?? DEFAULT_WINDOW_ITEMS,
    windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
  };
  const before = trailingWindow(items, index - 1, floor, win);
  const after = leadingWindow(items, index, { ...win, gapMs: opts.gapMs });

  const splitMeters = opts.splitMeters;
  const minConfirm = opts.minConfirm ?? DEFAULT_MIN_CONFIRM;
  const maxSpeedKmh = opts.maxSpeedKmh ?? DEFAULT_MAX_SPEED_KMH;

  // Each side is represented by the geotagged item nearest the boundary and the
  // other items in its window that agree with it. Averaging a whole window
  // outright would blend the two locations together and then blame the boundary
  // *before* the move for the difference.
  const beforeGeoItems = before.filter(hasGeo);
  const afterGeoItems = after.filter(hasGeo);
  const beforeAnchor = beforeGeoItems[beforeGeoItems.length - 1];
  const afterAnchor = afterGeoItems[0];

  let distance: number | undefined;
  if (beforeAnchor && afterAnchor) {
    const near = (items: ClusterItem[], anchor: ClusterItem) =>
      items.filter((i) => haversineMeters(anchor.lat as number, anchor.lng as number, i.lat as number, i.lng as number) <= splitMeters);
    const beforeSide = near(beforeGeoItems, beforeAnchor);
    const afterSide = near(afterGeoItems, afterAnchor);
    const from = centroidOf(beforeSide) as Geo;
    const to = centroidOf(afterSide) as Geo;
    const d = haversineMeters(from.lat, from.lng, to.lat, to.lng);

    // Under the split distance there is nothing to justify and the score just
    // records how close they were. Above it, the move has to be confirmed by
    // more than one item at the new location — a single stray coordinate is the
    // commonest cause of a spurious split — physically possible, and one-way:
    // neither window may hold, apart from its own side, items at the other
    // side's location. A phone that flickers between a good fix and a stale one
    // puts both places in the windows of every boundary in the run
    // (A B A A B | B), where a real move leaves each place on its own side
    // (A A A | B B). A failed test means the fixes are wrong, so location goes
    // back to unknown for this boundary rather than counting as evidence of a
    // difference.
    const confirmed = afterSide.length >= minConfirm;
    const plausible = impliedSpeedKmh(d, timeGap) <= maxSpeedKmh;
    const visits = (window: ClusterItem[], side: ClusterItem[], at: Geo) => {
      const own = new Set(side);
      return window.some((i) => !own.has(i) && haversineMeters(at.lat, at.lng, i.lat as number, i.lng as number) <= splitMeters);
    };
    const oneWay = !visits(beforeGeoItems, beforeSide, to) && !visits(afterGeoItems, afterSide, from);
    if (d <= splitMeters || (confirmed && plausible && oneWay)) distance = d;
  }

  // With no location evidence at all there is nothing for rule 2 to weigh
  // against the time gap, and rule 1 already said the gap is small — keep.
  if (distance === undefined) return { cut: false, scores: {}, reason: 'keep' };

  const scores: AlbumScores = {
    temporal: temporalSimilarity(timeGap, opts.timeHalfLifeMs),
    location: locationSimilarity(distance, opts.locationScaleM ?? splitMeters),
  };
  // People only count when both sides actually know someone. A photo of the cake
  // between two group shots has an empty set, and scoring that as "different
  // people" would be exactly backwards.
  const beforePeople = personsOf(before);
  const afterPeople = personsOf(after);
  if (beforePeople.length > 0 && afterPeople.length > 0) scores.people = jaccard(beforePeople, afterPeople);

  scores.overall = combineScores(scores);
  const cut = (scores.overall ?? 0) < (opts.boundaryThreshold ?? DEFAULT_BOUNDARY_THRESHOLD);
  return { cut, scores, reason: cut ? 'low-score' : 'keep' };
};

/**
 * Cohesion of a finished cluster, stored on the album so the grouping can be
 * explained. Temporal is the mean adjacent spacing, location the spread from the
 * centroid, people the share of appearances belonging to someone who appears
 * more than once — "are these the same people throughout, or a stream of
 * strangers?".
 *
 * Not the density of the member x person incidence matrix: that divides by the
 * size of the cast, so a large gathering would score near 0 purely for having
 * had many guests.
 */
const clusterScores = (items: ClusterItem[], opts: ClusterOptions): { scores: AlbumScores; centroid?: Geo } => {
  let temporal = 1;
  if (items.length >= 2) {
    let sum = 0;
    for (let i = 1; i < items.length; i++) sum += items[i].timeMs - items[i - 1].timeMs;
    temporal = temporalSimilarity(sum / (items.length - 1), opts.timeHalfLifeMs);
  }

  const geo = items.filter(hasGeo);
  const centroid = centroidOf(items);
  let location: number | undefined;
  if (centroid) {
    if (geo.length >= 2) {
      const spread = Math.max(...geo.map((i) => haversineMeters(centroid.lat, centroid.lng, i.lat as number, i.lng as number)));
      location = locationSimilarity(spread, opts.locationScaleM ?? opts.splitMeters);
    } else {
      location = 1; // a single fixed point is maximally cohesive
    }
  }

  const appearances = new Map<string, number>();
  for (const item of items) {
    for (const person of new Set(item.persons ?? [])) appearances.set(person, (appearances.get(person) ?? 0) + 1);
  }
  let people: number | undefined;
  if (appearances.size > 0) {
    let total = 0;
    let recurring = 0;
    for (const count of appearances.values()) {
      total += count;
      if (count > 1) recurring += count;
    }
    people = total === 0 ? 0 : recurring / total;
  }

  const scores: AlbumScores = { temporal };
  if (location !== undefined) scores.location = location;
  if (people !== undefined) scores.people = people;
  scores.overall = combineScores(scores);
  return { scores, centroid };
};

/**
 * Whether the pause before `items[index]` is long for its neighbourhood: at least 20 minutes, and
 * its logarithm at least ln 17 above the mean logarithm of the gaps within ten either side of it,
 * itself among them, up to the nearest pause over `gapMs` on either side.
 */
const adaptiveCut = (logGaps: number[], gaps: number[], index: number, gapMs: number): boolean => {
  if (gaps[index] < ADAPTIVE_MIN_GAP_MS) return false;
  let from = index;
  while (from - 1 >= Math.max(1, index - ADAPTIVE_WINDOW) && gaps[from - 1] <= gapMs) from--;
  let to = index;
  while (to + 1 <= Math.min(gaps.length - 1, index + ADAPTIVE_WINDOW) && gaps[to + 1] <= gapMs) to++;
  let sum = 0;
  for (let i = from; i <= to; i++) sum += logGaps[i];
  return logGaps[index] >= ADAPTIVE_LOG_FACTOR + sum / (to - from + 1);
};

/**
 * Cluster time-sorted items into auto-album candidates. `items` MUST be in `compareItems` order.
 * Returns clusters in time order; singletons are included.
 */
export const clusterMedia = (items: ClusterItem[], opts: ClusterOptions): Cluster[] => {
  const clusters: Cluster[] = [];
  if (items.length === 0) return clusters;

  let startIndex = 0;
  const flush = (endIndex: number) => {
    const slice = items.slice(startIndex, endIndex + 1);
    const { scores, centroid } = clusterScores(slice, opts);
    clusters.push({
      items: slice,
      timeStart: new Date(slice[0].timeMs).toISOString(),
      timeEnd: new Date(slice[slice.length - 1].timeMs).toISOString(),
      centroid,
      scores,
      ready: slice.every((i) => i.ready !== false),
      days: countDays(slice),
    });
  };

  const gaps = items.map((item, i) => i === 0 ? 0 : item.timeMs - items[i - 1].timeMs);
  const logGaps = gaps.map((gap) => Math.log(Math.max(gap, ADAPTIVE_FLOOR_MS)));
  for (let i = 1; i < items.length; i++) {
    const cut = opts.keep?.has(i)
      ? false
      : opts.cut?.has(i) || (opts.adaptive === true && adaptiveCut(logGaps, gaps, i, opts.gapMs)) || boundaryDecision(items, i, startIndex, opts).cut;
    if (cut) {
      flush(i - 1);
      startIndex = i;
    }
  }
  flush(items.length - 1);
  return clusters;
};

/**
 * The usual location: the densest cell of a grid laid over `points`, returned as
 * that cell's mean — or undefined when that cell holds less than `minShare` of
 * them, where no place stands out. Over a year of someone's photos that is home,
 * by a wide margin over every other cell. It is one of the homes `rollupClusters`
 * measures "away" against.
 *
 * A grid rather than a proper mode estimate because it costs one pass and the
 * margin is not close; a home straddling a cell edge only matters when it is.
 */
export const usualLocation = (points: Geo[], minShare = 0, cellDeg = DEFAULT_USUAL_LOCATION_CELL_DEG): Geo | undefined => {
  const cells = new Map<string, { n: number; lat: number; lng: number }>();
  for (const p of points) {
    const key = `${Math.floor(p.lat / cellDeg)}:${Math.floor(p.lng / cellDeg)}`;
    const cell = cells.get(key) ?? { n: 0, lat: 0, lng: 0 };
    cell.n++;
    cell.lat += p.lat;
    cell.lng += p.lng;
    cells.set(key, cell);
  }
  let best: { n: number; lat: number; lng: number } | undefined;
  for (const cell of cells.values()) if (!best || cell.n > best.n) best = cell;
  return best && best.n >= minShare * points.length ? { lat: best.lat / best.n, lng: best.lng / best.n } : undefined;
};

type RollupOptions = {
  /**
   * The usual location on a local day (`YYYY-MM-DD`): a home moves. On a day without one nothing
   * is away, and only the same-day rule applies.
   */
  home?: (day: string) => Geo | undefined;
  /** Distance (m) from `home` beyond which a part is away. */
  awayMeters?: number;
  /** Largest gap (ms) between two consecutive away parts of one stay. */
  stayGapMs?: number;
  /** Merge consecutive parts of one local day at the usual location. Default on. */
  dayMerge?: boolean;
  /** Distance (m) beyond which two parts that are each at one location are at different locations. */
  splitMeters: number;
  /** Share of the smaller cast that must appear in the larger for two same-day casts to agree. */
  peopleFloor?: number;
  /** Items a person cut after, by id: no two parts either side of one are rolled up together. */
  cutAfter?: ReadonlySet<string>;
  /** Items inside a run a person joined, by id: a stay is never split after one. */
  keepAfter?: ReadonlySet<string>;
};

/** Below this location cohesion a part was not at one location, so its centroid says nothing. */
const LOCATED_FLOOR = 0.3;

const startMs = (c: Cluster): number => c.items[0].timeMs;
const endMs = (c: Cluster): number => c.items[c.items.length - 1].timeMs;
const lastId = (c: Cluster): string => {
  const last = c.items[c.items.length - 1];
  return last.id ?? last.path;
};

/** Item-count-weighted mean of the parts' per-signal scores, with `overall` recombined. */
const rollupScores = (parts: Cluster[]): AlbumScores => {
  const scores: AlbumScores = {};
  for (const key of ['temporal', 'location', 'people'] as const) {
    let sum = 0;
    let weight = 0;
    for (const part of parts) {
      const v = part.scores[key];
      if (v === undefined) continue;
      sum += v * part.items.length;
      weight += part.items.length;
    }
    if (weight > 0) scores[key] = sum / weight;
  }
  scores.overall = combineScores(scores);
  return scores;
};

/**
 * How much of the smaller cast appears in the larger — 1 when one is a subset
 * of the other. Not Jaccard: six photos of the couple against thirty-six of
 * the whole wedding party are the same happening, and Jaccard would call that
 * 0.15.
 */
const castOverlap = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
};

/** A group of parts being rolled up, with what the rules need to know about it. */
type Group = {
  parts: Cluster[];
  away?: boolean;
  cast: Set<string>;
};

const groupOf = (part: Cluster, away: boolean | undefined): Group => ({ parts: [part], away, cast: new Set(personsOf(part.items)) });

const fold = (into: Group, group: Group): void => {
  into.parts.push(...group.parts);
  if (group.away === true) into.away = true;
  for (const p of group.cast) into.cast.add(p);
};

/** The centroid of a part that was at one location; undefined for a part spread over several. */
const locationOf = (part: Cluster): Geo | undefined => part.centroid && (part.scores.location ?? 0) >= LOCATED_FLOOR ? part.centroid : undefined;

/**
 * Roll level-1 parts up into albums. `parts` MUST be in time order and disjoint,
 * as `clusterMedia` returns them.
 *
 * Two rules, applied to consecutive parts:
 *
 *   **Stay.** Parts that are both *away* — further than `awayMeters` from the
 *   usual location — and no more than `stayGapMs` apart are one album. That is what
 *   a trip is: not one location (a road trip moves every day) but a run of days spent
 *   away, ended by coming home. A part with no coordinates joins a stay when it
 *   sits between two away parts within the gap (the museum, the restaurant); at
 *   the edges it stays out, since nothing says it belongs. The same rule folds a
 *   day trip's morning and evening together, and re-joins parts level 1 cut on a
 *   low boundary score inside a trip, where the trip is the unit anyway.
 *
 *   **Day.** At the usual location, one local day is one happening. Nobody makes a
 *   "Saturday morning" album and a "Saturday evening" album; they make
 *   Saturday — and a wedding moves from the church to the dinner, which level
 *   1, comparing five-photo windows of a large, shifting cast, cuts into a
 *   morning, a ceremony, a dinner and three fragments. Two happenings on one
 *   day are told apart only when **both** signals say so: the casts both know
 *   someone and share less than `peopleFloor` of the smaller one (the
 *   football team, then dinner with friends), *and* each part was at one
 *   location, further than `splitMeters` from the other. Either alone is not
 *   enough — casts in six-photo slices of a party are always partly
 *   different, and an afternoon that moves is still one afternoon. Anyone
 *   seen earlier in the day ties a part to that earlier happening, and to
 *   everything between.
 *
 * A rolled-up cluster keeps its parts, and its scores are the parts' weighted
 * mean: the grouping rests on the days being consecutive and away, or on the
 * cast, not on temporal cohesion across nights, so scoring it as one long
 * cluster would only report that people sleep.
 */
export const rollupClusters = (parts: Cluster[], opts: RollupOptions): Cluster[] => {
  if (parts.length === 0) return [];
  const awayMeters = opts.awayMeters ?? DEFAULT_AWAY_METERS;
  const stayGapMs = opts.stayGapMs ?? DEFAULT_STAY_GAP_MS;
  const dayMerge = opts.dayMerge ?? true;
  const peopleFloor = opts.peopleFloor ?? DEFAULT_DAY_PEOPLE_FLOOR;
  const homeOn = opts.home ?? ((): Geo | undefined => undefined);
  const cutAfter = opts.cutAfter ?? new Set<string>();
  /** Whether a person cut between part `i - 1` and part `i`. */
  const blocked = (i: number): boolean => cutAfter.has(lastId(parts[i - 1]));

  // 1. Away, home, or unknown — per part, against the home of the day it starts on.
  const away: (boolean | undefined)[] = parts.map((part) => {
    const home = homeOn(dayOf(part.items[0]));
    if (!home || !part.centroid) return undefined;
    return haversineMeters(part.centroid.lat, part.centroid.lng, home.lat, home.lng) > awayMeters;
  });
  const gapBefore = (i: number): number => startMs(parts[i]) - endMs(parts[i - 1]);

  // 2. A run of unknowns between two away parts, every gap within the stay gap, is away.
  for (let i = 0; i < parts.length;) {
    if (away[i] !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < parts.length && away[j] === undefined) j++;
    if (i > 0 && j < parts.length && away[i - 1] === true && away[j] === true) {
      let within = true;
      for (let k = i; k <= j && within; k++) within = gapBefore(k) <= stayGapMs;
      if (within) { for (let k = i; k < j; k++) away[k] = true; }
    }
    i = j;
  }

  // 3. Stays: consecutive away parts within the gap.
  const stays: Group[] = [];
  for (let i = 0; i < parts.length; i++) {
    const group = stays[stays.length - 1];
    if (group && group.away === true && away[i] === true && gapBefore(i) <= stayGapMs && !blocked(i)) {
      fold(group, groupOf(parts[i], away[i]));
      continue;
    }
    stays.push(groupOf(parts[i], away[i]));
  }

  // 4. Days: among what is left at home, one local day is one happening unless
  //    both who and where say otherwise.
  const dayOfGroup = (group: Group): string => dayOf(group.parts[0].items[0]);
  const locationsDisagree = (a: Group, b: Group): boolean => {
    const from = locationOf(a.parts[a.parts.length - 1]);
    const to = locationOf(b.parts[0]);
    return !!from && !!to && haversineMeters(from.lat, from.lng, to.lat, to.lng) > opts.splitMeters;
  };
  const groups: Group[] = [];
  let dayStart = 0; // index in `groups` where the current day's run at home begins
  for (const group of capStays(stays, opts.keepAfter ?? new Set())) {
    const prev = groups[groups.length - 1];
    const cutBefore = prev !== undefined && cutAfter.has(lastId(prev.parts[prev.parts.length - 1]));
    if (!dayMerge || !prev || cutBefore || prev.away === true || group.away === true || dayOfGroup(prev) !== dayOfGroup(group)) {
      groups.push(group);
      dayStart = groups.length - 1;
      continue;
    }
    if (group.cast.size > 0) {
      // Anyone seen earlier today ties this part to that happening — and to
      // everything between, which is then one afternoon that wandered.
      const first = groups.findIndex((g, i) => i >= dayStart && g.cast.size > 0 && castOverlap(group.cast, g.cast) >= peopleFloor);
      if (first >= 0) {
        const into = groups[first];
        for (const later of groups.splice(first + 1)) fold(into, later);
        fold(into, group);
        continue;
      }
      // Nobody in common with the part before, and each at its own location, far
      // apart: two happenings. Either signal alone is not enough.
      if (prev.cast.size > 0 && locationsDisagree(prev, group)) {
        groups.push(group);
        continue;
      }
    }
    fold(prev, group);
  }

  return groups.map(clusterOfGroup);
};

/** The local days a stay covers, first to last. */
const spanDays = (parts: Cluster[]): number => {
  const first = Date.parse(dayOf(parts[0].items[0]));
  const lastPart = parts[parts.length - 1];
  const last = Date.parse(dayOf(lastPart.items[lastPart.items.length - 1]));
  return Math.round((last - first) / 86_400_000) + 1;
};

/**
 * Stays longer than `STAY_CAP_DAYS` local days split at their longest pause between parts, again
 * and again until every piece fits: a summer at the cottage is weeks, not one album. A pause inside
 * a run a person joined is never the one split at.
 */
const capStays = (stays: Group[], keepAfter: ReadonlySet<string>): Group[] => {
  const out: Group[] = [];
  const split = (group: Group): void => {
    if (group.away !== true || group.parts.length < 2 || spanDays(group.parts) <= STAY_CAP_DAYS) {
      out.push(group);
      return;
    }
    let at = -1;
    let longest = -1;
    for (let i = 1; i < group.parts.length; i++) {
      if (keepAfter.has(lastId(group.parts[i - 1]))) continue;
      const gap = startMs(group.parts[i]) - endMs(group.parts[i - 1]);
      if (gap > longest) {
        longest = gap;
        at = i;
      }
    }
    if (at < 0) {
      out.push(group);
      return;
    }
    const pieceOf = (parts: Cluster[]): Group => {
      const piece: Group = { parts: [], away: true, cast: new Set() };
      for (const part of parts) fold(piece, { parts: [part], away: true, cast: new Set(personsOf(part.items)) });
      return piece;
    };
    split(pieceOf(group.parts.slice(0, at)));
    split(pieceOf(group.parts.slice(at)));
  };
  for (const group of stays) split(group);
  return out;
};

/** A rolled-up group as one cluster: a single part as it is, several as their union with the parts kept. */
const clusterOfGroup = (group: Group): Cluster => {
  if (group.parts.length === 1) return group.away === undefined ? group.parts[0] : { ...group.parts[0], away: group.away };
  const items = group.parts.flatMap((p) => p.items);
  const days = countDays(items);
  const cluster: Cluster = {
    items,
    timeStart: group.parts[0].timeStart,
    timeEnd: group.parts[group.parts.length - 1].timeEnd,
    centroid: centroidOf(items),
    scores: rollupScores(group.parts),
    ready: group.parts.every((p) => p.ready),
    days,
    parts: group.parts,
  };
  if (group.away !== undefined) cluster.away = group.away;
  if (group.away && days >= 2) cluster.kind = 'trip';
  return cluster;
};

/** Longest overnight pause between two days at home that may still be joined. */
const HOME_MERGE_GAP_MS = 36 * 60 * 60 * 1000;
/** Most local days a run of joined days at home may cover. */
const HOME_MERGE_MAX_DAYS = 4;

type HomeMergeOptions = {
  /** Whether two consecutive days at home share something that makes them one happening. */
  evidence: (a: Cluster, b: Cluster) => boolean;
  /** Items a person cut after, by id: no two days either side of one are joined. */
  cutAfter?: ReadonlySet<string>;
};

/**
 * Join consecutive days at home (or of unknown place) into one album when the night between is at
 * most 36 hours, the run stays within 4 local days, and `evidence` says the two days belong
 * together — a guest seen on both, a cottage, a holiday pair, two big days side by side. A day
 * that is away, or a trip, is never joined. The joined album keeps every part and says `merged`.
 */
export const mergeHomeDays = (clusters: Cluster[], opts: HomeMergeOptions): Cluster[] => {
  const cutAfter = opts.cutAfter ?? new Set<string>();
  const out: Cluster[] = [];
  for (const cluster of clusters) {
    const prev = out[out.length - 1];
    const home = (c: Cluster) => c.away !== true && c.kind !== 'trip';
    if (
      prev && home(prev) && home(cluster) && !cutAfter.has(lastId(prev)) &&
      dayOf(prev.items[prev.items.length - 1]) !== dayOf(cluster.items[0]) &&
      startMs(cluster) - endMs(prev) <= HOME_MERGE_GAP_MS &&
      spanDays([prev, cluster]) <= HOME_MERGE_MAX_DAYS &&
      opts.evidence(prev, cluster)
    ) {
      const parts = [...(prev.parts ?? [prev]), ...(cluster.parts ?? [cluster])];
      out[out.length - 1] = { ...clusterOfGroup({ parts, away: prev.away ?? cluster.away, cast: new Set() }), merged: true };
      continue;
    }
    out.push(cluster);
  }
  return out;
};

/**
 * Distinct shots among `items` (in time order): an item a few seconds after the one before, from
 * the same camera or with neither naming one, is the same shot again — a burst, or a copy.
 */
export const shotsOf = (items: ClusterItem[]): number => {
  let shots = 0;
  for (let i = 0; i < items.length; i++) {
    const prev = items[i - 1];
    if (!prev || items[i].timeMs - prev.timeMs > SHOT_GAP_MS || items[i].device !== prev.device) shots++;
  }
  return shots;
};

/**
 * A year's usual day, from the distinct shots of each day with photos that year: their median,
 * rounded down to `BASELINE_LADDER`, so a few more photos do not move it. 1 for a year with none.
 */
export const baselineOf = (dayShots: number[]): number => {
  if (dayShots.length === 0) return 1;
  const sorted = dayShots.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let value = BASELINE_LADDER[0];
  for (const step of BASELINE_LADDER) if (step <= median) value = step;
  return value;
};
