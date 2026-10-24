/**
 * How a category's media are grouped: a pure plan, from the items and what is known of them to
 * the groups they fall into, in which every item is in exactly one group (`planCategory`). The
 * organizer reads the items and writes the groups; nothing here does any IO.
 *
 * The category's strategy (`stagingCategory.group.strategy`) decides the claim order:
 *
 * | strategy  | each item goes to the first that claims it                                       |
 * | --------- | -------------------------------------------------------------------------------- |
 * | `events`  | a seed (a folder a person named), clutter, the timeline, a period lane, undated   |
 * | `folders` | a run of scans in its folder, in file-name order; capture time never groups them  |
 * | `none`    | a lane per folder and month, a period lane, an undated lane per folder            |
 *
 * On the timeline, the rules of `cluster.ts` cut parts and roll them up into events and trips. An
 * event is kept as a group of its own only when it is significant: a trip, away from home, more
 * shots than the category's usual day that year, days joined at home, a named place, a holiday or
 * a birthday, guests, or a person's edit. Everything else goes to its year's Everyday lane, which
 * splits into months, once and for good, above 400 items. A person's edits (`StagingEdit`) are
 * applied on every plan: cuts and joins as boundaries, dismissals as demotions, and assignments
 * last of all.
 *
 * The timeline falls into segments: runs of items no pause of more than two days breaks, joined
 * where they share a local day or a person joined across one. No rule looks across a segment's
 * edge, so a segment is planned the same alone as with the rest of the category, given each year's
 * usual day. That is what lets the organizer plan part of a category (`PlanContext.seedFolders`,
 * `dayShots`, `loose`) and get the groups a plan of the whole would give.
 */
import type { GroupKind, GroupStrategy, SignificancePreset, SignificanceReason, StagingEdit } from '@archive/staging/api';
import { baselineOf, type Cluster, type ClusterItem, clusterMedia, compareItems, dayOf, mergeHomeDays, rollupClusters, shotsOf } from '@archive/staging/cluster';
import { type CastMember, holidayPair, occasionOf } from '@archive/staging/naming';
import { haversineMeters } from '@archive/staging/scoring';

type Geo = { lat: number; lng: number };

/** How far an item's capture time is known: to the day or finer, to a month, to a year, or not at all. */
export type Precision = 'instant' | 'month' | 'year' | 'none';

/** A staged medium as planning reads it: a `ClusterItem` with its file and folder. */
export type PlanItem = ClusterItem & {
  id: string;
  /** The file's name. */
  name: string;
  /** The folder it is in, by node id and path. */
  folderId: string;
  folder: string;
  mimetype: string;
  width?: number;
  height?: number;
  /** The wall clock it was taken at, as stored. */
  takenAt?: string;
  takenAtSource?: string;
  precision: Precision;
  faceCount?: number;
  /** The phone folder a Google Photos upload came from (its Takeout sidecar's `localFolder`). */
  localFolder?: string;
};

/** A folder holding items: its node id, path, name, depth below the category and title (a Takeout album's). */
export type PlanFolder = { id: string; path: string; name: string; depth: number; title?: string };

/** How a lane is named. */
type LaneLabel = { kind: 'loose' | 'clutter' | 'undated' | 'period' | 'month'; period?: string; folder?: string; chunk?: number };

/** One group of a plan. */
export type PlannedGroup = {
  kind: GroupKind;
  /** A lane's or a seed's key, by which the organizer finds it again; none for events, trips and runs. */
  key?: string;
  /** Its members, in time order (lanes and runs: in their own order). */
  items: PlanItem[];
  shots: number;
  /** Events and trips: what was rolled up into them. */
  cluster?: Cluster;
  significance?: { reason: SignificanceReason; baseline: number };
  precision?: 'year' | 'month';
  folderId?: string;
  seed?: { source: 'takeout-album' | 'folder'; label: string };
  /** A scan run's name: its folder below the category, and its years when most are dated by hand. */
  run?: { label: string; years?: string };
  lane?: LaneLabel;
};

/** What planning knows beside the items, each read once by the organizer. */
export type PlanContext = {
  strategy: GroupStrategy;
  significance: SignificancePreset;
  /** The live edits of the category, oldest first. */
  edits: StagingEdit[];
  folders: ReadonlyMap<string, PlanFolder>;
  /** Home on a local day; none means nothing that day is away. */
  home?: (day: string) => Geo | undefined;
  /** Whether someone is a guest: not of the household, and rarely in the library's pictures. */
  isGuest?: (personId: string) => boolean;
  /** The people an occasion can be the birthday of, by person id. */
  cast?: (personId: string) => CastMember | undefined;
  /** Whether a run of items was at a named place that is not home: a location, or a point of interest. */
  atPlace?: (items: PlanItem[]) => boolean;
  /** The lanes split into months by an earlier run, by key (`loose:2014`): they stay split. */
  granularity?: Readonly<Record<string, 'year' | 'month'>>;
  /**
   * The folders that are seeds, decided beforehand from all their items; absent, they are counted
   * from the items. A plan of part of a category is given them, as it holds part of a folder.
   */
  seedFolders?: ReadonlySet<string>;
  /** The distinct shots of the photographed days the timeline items do not cover, by local day: each year's usual day counts them. */
  dayShots?: ReadonlyMap<string, number>;
  /**
   * Items known to go to an Everyday or a clutter lane, by id, without being planned on the
   * timeline or classified: the members a plan of part of a category leaves in their lanes.
   */
  lanes?: ReadonlyMap<string, 'loose' | 'clutter'>;
};

/** A run of timeline items no pause over `SEGMENT_GAP_MS` breaks, by its first and last instant (ms) and its local days. */
export type Segment = { start: number; end: number; days: string[] };

/**
 * A plan: its groups, the lanes now split into months, each year's usual day, the folders that are
 * seeds, and of the timeline items it planned, the shots of each of their days and their segments.
 */
export type Plan = {
  groups: PlannedGroup[];
  granularity: Record<string, 'year' | 'month'>;
  baselines: Record<string, number>;
  seeds: string[];
  dayShots: Record<string, number>;
  segments: Segment[];
};

const HOUR_MS = 60 * 60 * 1000;
/** Level 1: a pause this long always cuts; a move this far, confirmed, may. */
const GAP_MS = 4 * HOUR_MS;
/** A pause longer than this ends a segment of the timeline: no rule joins across it (stays join across two days at most). */
export const SEGMENT_GAP_MS = 48 * HOUR_MS;
const SPLIT_METERS = 2_000;
/** A lane switches to months above this many items, and a month is chunked above the next. */
const LANE_MONTHLY_ABOVE = 400;
const LANE_CHUNK = 1_000;
/** A folder needs this many items to be a seed; a scan run this many to stand alone. */
const SEED_MIN = 3;
const RUN_MIN = 3;
/** A scan run splits where the counter jumps further than this, and at its largest jump above `RUN_MAX`. */
const RUN_JUMP = 20;
const RUN_MAX = 300;
/** A dismissal covers a group holding at least this share of members it names. */
const DISMISS_SHARE = 0.8;
/** The significance presets: shots against the year's usual day (`mult` times it) and the least a group needs (`floor`). */
const PRESETS: Record<SignificancePreset, { mult: number; floor: number }> = {
  fewer: { mult: 3, floor: 5 },
  normal: { mult: 2, floor: 4 },
  more: { mult: 1.5, floor: 3 },
};
/** Home-day merge: a cottage is at least this far from home, and two days' places at most this far apart. */
const COTTAGE_METERS = 5_000;
const SAME_PLACE_METERS = 2_000;

/** Add `value` to the list `map` keeps under `key`, making the list on first use. */
const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

// ── clutter ─────────────────────────────────────────────────────────────────

const SCREENSHOT_NAME = /^(Screenshot|Screen Shot|Skärmavbild|Skärmbild)/i;
const SCREENSHOT_FOLDER = /screenshots?/i;
const SAVED_NAME = [/^IMG-\d{8}-WA\d+/, /^signal-\d{4}-/, /^FB_IMG_/, /^received_/];
const SAVED_FOLDER = /whatsapp|telegram|messenger|signal/i;
/** Phone screen sizes, portrait; a PNG or WebP of one of them, or landscape, with no camera is a screenshot. */
const SCREEN_SIZES = new Set(['750x1334', '768x1280', '1080x1920', '1080x2340', '1125x2436', '1170x2532', '1242x2688', '1440x3200']);

/** What an item's own attrs and path say clutter is. */
type ClutterInput = { name: string; mimetype: string; width?: number; height?: number; takenAtSource?: string; devicePath?: string; folderNames: string[] };

/**
 * Whether an item is a screenshot or an image saved from a message, from its name, folders, type
 * and size alone; undefined for neither. Never stored.
 */
export const classifyItem = (input: ClutterInput): 'screenshot' | 'saved' | undefined => {
  if (SCREENSHOT_NAME.test(input.name) || input.folderNames.some((name) => SCREENSHOT_FOLDER.test(name))) return 'screenshot';
  const flat = input.mimetype === 'image/png' || input.mimetype === 'image/webp';
  if (flat && !input.devicePath && input.takenAtSource !== 'gps' && input.width && input.height) {
    if (SCREEN_SIZES.has(`${input.width}x${input.height}`) || SCREEN_SIZES.has(`${input.height}x${input.width}`)) return 'screenshot';
  }
  if (SAVED_NAME.some((pattern) => pattern.test(input.name)) || input.folderNames.some((name) => SAVED_FOLDER.test(name))) return 'saved';
  return undefined;
};

// ── folders ─────────────────────────────────────────────────────────────────

const MACHINE_NAMES = [
  /^DCIM$/i,
  /^Camera$/i,
  /^\d{3}[A-Z_]+$/,
  /^\d{4}$/,
  /^\d{4}-\d{2}(-\d{2})?$/,
  /^(Photos from|Foton från|Bilder från) \d{4}$/i,
  /^Takeout$/i,
  /^Google (Photos|Foto)$/i,
  /^Archive$/i,
  /^Trash$/i,
  /^Locked Folder$/i,
  /^WhatsApp/i,
  /^Screenshots?$/i,
  /^Sent$/i,
  /^Download/i,
  /^upload-\d{4}-\d{2}-\d{2}/i,
  /^\d{8}[_ -]?\d{4,6}$/,
  /^\d{4}-\d{2}-\d{2}[ T_]\d{2}[.:-]?\d{2}/,
];

/** Whether a folder's name is one a camera, an export or an upload gave it, rather than a person. */
export const isMachineName = (name: string): boolean => MACHINE_NAMES.some((pattern) => pattern.test(name.trim()));

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** File names as a person sorts them: `IMG_2` before `IMG_10`. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** A file name taken apart: its stem without the trailing counter, and the counter. */
const counterOf = (name: string): { stem: string; counter?: number } => {
  const base = name.replace(/\.[^.]*$/, '');
  const match = base.match(/^(.*?)(\d+)$/);
  return match ? { stem: match[1], counter: Number(match[2]) } : { stem: base };
};

const yearOfManual = (item: PlanItem): string | undefined => item.takenAtSource === 'manual' && item.takenAt ? item.takenAt.slice(0, 4) : undefined;

/**
 * One folder's scans as runs, in file-name order: a run ends where the stem changes, the counter
 * jumps by more than 20, two neighbours carry dates set by hand in different years, or a person
 * cut (`cutAfter`); a run above 300 splits at its largest jump. A run of fewer than three joins the
 * one before it in the folder, unless a person cut between them.
 */
export const folderRuns = (items: PlanItem[], cutAfter: ReadonlySet<string> = new Set()): PlanItem[][] => {
  const sorted = items.toSorted((a, b) => naturalCompare(a.name, b.name));
  const runs: PlanItem[][] = [];
  for (const item of sorted) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (prev) {
      const [a, b] = [counterOf(prev.name), counterOf(item.name)];
      const [ya, yb] = [yearOfManual(prev), yearOfManual(item)];
      const jump = a.counter !== undefined && b.counter !== undefined ? Math.abs(b.counter - a.counter) : 0;
      const breaks = cutAfter.has(prev.id) || a.stem !== b.stem || jump > RUN_JUMP || (ya !== undefined && yb !== undefined && ya !== yb);
      if (!breaks) {
        run.push(item);
        continue;
      }
    }
    runs.push([item]);
  }
  const capped = runs.flatMap((run) => capRun(run));
  const out: PlanItem[][] = [];
  for (const run of capped) {
    const prev = out[out.length - 1];
    if (prev && run.length < RUN_MIN && !cutAfter.has(prev[prev.length - 1].id)) prev.push(...run);
    else out.push(run);
  }
  return out;
};

/** A run above `RUN_MAX`, split at its largest counter jump until every piece fits. */
const capRun = (run: PlanItem[]): PlanItem[][] => {
  if (run.length <= RUN_MAX) return [run];
  let at = Math.floor(run.length / 2);
  let largest = -1;
  for (let i = 1; i < run.length; i++) {
    const [a, b] = [counterOf(run[i - 1].name).counter, counterOf(run[i].name).counter];
    const jump = a !== undefined && b !== undefined ? b - a : 0;
    if (jump > largest) {
      largest = jump;
      at = i;
    }
  }
  return [...capRun(run.slice(0, at)), ...capRun(run.slice(at))];
};

// ── lanes ───────────────────────────────────────────────────────────────────

/** The period a dated item's lane is for: its local year, or its month once that lane is split. */
const periodOf = (item: PlanItem, monthly: boolean): string => monthly ? dayOf(item).slice(0, 7) : dayOf(item).slice(0, 4);

/** An item's period lane value: `1987` or `1987-06`, from its wall clock. */
export const periodValue = (item: PlanItem): string => (item.takenAt ?? '').slice(0, item.precision === 'month' ? 7 : 4);

/**
 * Dated lane items (Everyday or clutter) as their lanes: a year's lane, or once it has held more
 * than 400 items (now or before, `granularity`), a lane per month, a month above 1,000 items
 * chunked at day boundaries.
 */
const datedLanes = (kind: 'loose' | 'clutter', items: PlanItem[], granularity: Record<string, 'year' | 'month'>): PlannedGroup[] => {
  const byYear = new Map<string, PlanItem[]>();
  for (const item of items.toSorted(compareItems)) {
    const year = dayOf(item).slice(0, 4);
    pushTo(byYear, year, item);
  }
  const groups: PlannedGroup[] = [];
  for (const [year, inYear] of byYear) {
    const yearKey = `${kind}:${year}`;
    if (inYear.length > LANE_MONTHLY_ABOVE) granularity[yearKey] = 'month';
    const monthly = granularity[yearKey] === 'month';
    const byPeriod = new Map<string, PlanItem[]>();
    for (const item of inYear) {
      const period = periodOf(item, monthly);
      pushTo(byPeriod, period, item);
    }
    for (const [period, inPeriod] of byPeriod) {
      chunkByDay(inPeriod).forEach((chunk, i) => {
        groups.push(laneGroup(kind, `${kind}:${period}${i > 0 ? `#${i + 1}` : ''}`, chunk, { kind, period, chunk: i + 1 }));
      });
    }
  }
  return groups;
};

/** Items in time order cut into chunks of at most `LANE_CHUNK`, never inside a local day (a day bigger than that is a chunk alone). */
const chunkByDay = (items: PlanItem[]): PlanItem[][] => {
  if (items.length <= LANE_CHUNK) return [items];
  const perDay = new Map<string, number>();
  for (const item of items) perDay.set(dayOf(item), (perDay.get(dayOf(item)) ?? 0) + 1);
  const chunks: PlanItem[][] = [[]];
  let day = '';
  for (const item of items) {
    const current = chunks[chunks.length - 1];
    if (dayOf(item) !== day && current.length > 0 && current.length + perDay.get(dayOf(item))! > LANE_CHUNK) chunks.push([]);
    day = dayOf(item);
    chunks[chunks.length - 1].push(item);
  }
  return chunks;
};

/** Items with no instant to place them at as lanes keyed per folder (and period value), in file-name order, chunked. */
const folderLanes = (
  kind: 'undated' | 'period',
  items: PlanItem[],
  folders: ReadonlyMap<string, PlanFolder>,
): PlannedGroup[] => {
  const byKey = new Map<string, PlanItem[]>();
  for (const item of items) {
    const key = kind === 'undated' ? `undated:${item.folderId}` : `period:${periodValue(item)}:${item.folderId}`;
    pushTo(byKey, key, item);
  }
  const groups: PlannedGroup[] = [];
  for (const [key, inKey] of byKey) {
    const sorted = inKey.toSorted((a, b) => naturalCompare(a.name, b.name));
    const folder = folders.get(sorted[0].folderId)?.name ?? sorted[0].folder.split('/').pop() ?? '';
    for (let i = 0; i * LANE_CHUNK < sorted.length; i++) {
      const chunk = sorted.slice(i * LANE_CHUNK, (i + 1) * LANE_CHUNK);
      const group = laneGroup(kind === 'undated' ? 'undated' : 'loose', `${key}${i > 0 ? `#${i + 1}` : ''}`, chunk, {
        kind,
        folder,
        chunk: i + 1,
        ...(kind === 'period' ? { period: periodValue(sorted[0]) } : {}),
      });
      group.folderId = sorted[0].folderId;
      if (kind === 'period') group.precision = sorted[0].precision === 'month' ? 'month' : 'year';
      groups.push(group);
    }
  }
  return groups;
};

const laneGroup = (kind: GroupKind, key: string, items: PlanItem[], lane: LaneLabel): PlannedGroup => ({
  kind,
  key,
  items,
  shots: shotsOf(items.filter((item) => item.precision === 'instant').toSorted(compareItems)),
  lane,
});

// ── edits ───────────────────────────────────────────────────────────────────

/** The live edits taken apart by what they do. */
type EditSets = {
  cutAfter: Set<string>;
  joins: { first: string; last: string; bounded: boolean }[];
  dismissals: Set<string>[];
  assigns: { items: string[]; with: string }[];
};

const editSets = (edits: StagingEdit[]): EditSets => {
  const sets: EditSets = { cutAfter: new Set(), joins: [], dismissals: [], assigns: [] };
  for (const edit of edits) {
    if (edit.op === 'cut') sets.cutAfter.add(edit.after);
    else if (edit.op === 'join') sets.joins.push({ first: edit.first, last: edit.last, bounded: edit.bounded === true });
    else if (edit.op === 'dismiss') sets.dismissals.push(new Set(edit.members));
    else sets.assigns.push({ items: edit.items, with: edit.with });
  }
  return sets;
};

/** Whether a person said `members` are not a group: at least 80% of them in one dismissal. */
const dismissed = (members: PlanItem[], dismissals: Set<string>[]): boolean =>
  dismissals.some((set) => members.filter((item) => set.has(item.id)).length >= DISMISS_SHARE * members.length);

// ── the timeline ────────────────────────────────────────────────────────────

/** The local day's distinct shots of each day of `items` (in time order). */
export const dayShotsOf = (items: PlanItem[]): Map<string, number> => {
  const byDay = new Map<string, PlanItem[]>();
  for (const item of items) pushTo(byDay, dayOf(item), item);
  return new Map([...byDay].map(([day, inDay]) => [day, shotsOf(inDay)]));
};

/** The local days of a cluster, in order. */
const daysOf = (cluster: Cluster): string[] => [...new Set(cluster.items.map(dayOf))].sort();

/** The centroid of a cluster that was at one place, else undefined. */
const placeOf = (cluster: Cluster): Geo | undefined => cluster.centroid && (cluster.scores.location ?? 0) >= 0.3 ? cluster.centroid : undefined;

/**
 * The segments of the timeline items `sorted` (in `compareItems` order): runs no pause over
 * `SEGMENT_GAP_MS` breaks, and none inside a run a person joined (`joined`, by index), each joined
 * with every segment between it and another sharing a local day.
 */
const segmentsOf = (sorted: PlanItem[], joined: ReadonlySet<number>): Segment[] => {
  const merged: { from: number; to: number; days: Set<string> }[] = [];
  const seen = new Map<string, number>();
  let from = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && (joined.has(i) || sorted[i].timeMs - sorted[i - 1].timeMs <= SEGMENT_GAP_MS)) continue;
    const days = new Set(sorted.slice(from, i).map(dayOf));
    let at = merged.length;
    for (const day of days) at = Math.min(at, seen.get(day) ?? at);
    if (at < merged.length) {
      const head = merged[at];
      for (const later of merged.splice(at + 1)) for (const day of later.days) head.days.add(day);
      head.to = i - 1;
      for (const day of days) head.days.add(day);
      for (const day of head.days) seen.set(day, at);
    } else {
      merged.push({ from, to: i - 1, days });
      for (const day of days) seen.set(day, merged.length - 1);
    }
    from = i;
  }
  return merged.map((segment) => ({ start: sorted[segment.from].timeMs, end: sorted[segment.to].timeMs, days: [...segment.days].sort() }));
};

/**
 * Plan the timeline: parts, rolled up into events and trips, days at home joined where they share
 * something; each kept when significant against its year's usual day (counted over these items'
 * days and the others `ctx.dayShots` gives), else its items left for the Everyday lanes. Also
 * answers each year's usual day, and the shots of these items' days and their segments.
 */
const planTimeline = (
  items: PlanItem[],
  ctx: PlanContext,
  edits: EditSets,
): { kept: PlannedGroup[]; loose: PlanItem[]; baselines: Record<string, number>; dayShots: Map<string, number>; segments: Segment[] } => {
  const sorted = items.toSorted(compareItems);
  const position = new Map(sorted.map((item, i) => [item.id, i]));
  // A person's cut is a boundary within a segment: across a pause that ends one there is a boundary
  // already, and what lies beyond it is no part of the group either side.
  const within = (i: number): boolean => i > 0 && i < sorted.length && sorted[i].timeMs - sorted[i - 1].timeMs <= SEGMENT_GAP_MS;
  const cut = new Set<number>();
  for (const id of edits.cutAfter) {
    const at = position.get(id);
    if (at !== undefined && within(at + 1)) cut.add(at + 1);
  }
  const keep = new Set<number>();
  const keepAfter = new Set<string>();
  for (const join of edits.joins) {
    const [first, last] = [position.get(join.first), position.get(join.last)];
    if (first === undefined || last === undefined) continue;
    const [from, to] = [Math.min(first, last), Math.max(first, last)];
    for (let i = from + 1; i <= to; i++) {
      keep.add(i);
      keepAfter.add(sorted[i - 1].id);
    }
    if (join.bounded) {
      if (within(from)) {
        cut.add(from);
        edits.cutAfter.add(sorted[from - 1].id);
      }
      if (within(to + 1)) {
        cut.add(to + 1);
        edits.cutAfter.add(sorted[to].id);
      }
    }
  }

  const dayShots = dayShotsOf(sorted);
  const byYear = new Map<string, number[]>();
  for (const [day, shots] of ctx.dayShots ?? []) if (!dayShots.has(day)) pushTo(byYear, day.slice(0, 4), shots);
  for (const [day, shots] of dayShots) pushTo(byYear, day.slice(0, 4), shots);
  const baselines: Record<string, number> = {};
  for (const [year, shots] of byYear) baselines[year] = baselineOf(shots);

  const preset = PRESETS[ctx.significance];
  const isGuest = ctx.isGuest ?? (() => false);
  const guestsIn = (cluster: Cluster): Set<string> => new Set(cluster.items.flatMap((item) => item.persons ?? []).filter(isGuest));
  const cast = (cluster: Cluster): CastMember[] => [...new Set(cluster.items.flatMap((item) => item.persons ?? []))].flatMap((id) => ctx.cast?.(id) ?? []);

  /** Why a cluster is a group of its own, by the first rule that holds; the rules that need a person's edit or a merge left to the caller. */
  const ownReason = (cluster: Cluster): SignificanceReason | undefined => {
    const shots = shotsOf(cluster.items);
    const baseline = baselines[dayOf(cluster.items[0]).slice(0, 4)] ?? 1;
    if (cluster.kind === 'trip') return 'trip';
    if (cluster.away === true && shots >= 3) return 'away';
    if (shots >= Math.max(preset.floor, preset.mult * baseline)) return 'size';
    if (cluster.merged && shots >= preset.floor) return 'merged';
    if (shots >= preset.floor && ctx.atPlace?.(cluster.items as PlanItem[])) return 'place';
    if (shots >= 3 && occasionOf(daysOf(cluster), cast(cluster)) !== undefined) return 'occasion';
    const guests = guestsIn(cluster);
    if (guests.size > 0 && cluster.items.filter((item) => (item.persons ?? []).some((p) => guests.has(p))).length >= 3) return 'guests';
    return undefined;
  };

  const home = ctx.home ?? (() => undefined);
  const parts = clusterMedia(sorted, { gapMs: GAP_MS, splitMeters: SPLIT_METERS, adaptive: true, cut, keep });
  const rolled = rollupClusters(parts, { home, splitMeters: SPLIT_METERS, cutAfter: edits.cutAfter, keepAfter });
  const evidence = (a: Cluster, b: Cluster): boolean => {
    const ga = guestsIn(a);
    if ([...guestsIn(b)].some((p) => ga.has(p))) return true;
    const [pa, pb] = [placeOf(a), placeOf(b)];
    const homeAt = home(dayOf(a.items[0]));
    if (pa && pb && homeAt && haversineMeters(pa.lat, pa.lng, pb.lat, pb.lng) <= SAME_PLACE_METERS) {
      if (haversineMeters(pa.lat, pa.lng, homeAt.lat, homeAt.lng) >= COTTAGE_METERS && haversineMeters(pb.lat, pb.lng, homeAt.lat, homeAt.lng) >= COTTAGE_METERS) return true;
    }
    if (holidayPair(dayOf(a.items[a.items.length - 1]), dayOf(b.items[0]))) return true;
    const apart = pa && pb ? haversineMeters(pa.lat, pa.lng, pb.lat, pb.lng) > SAME_PLACE_METERS : false;
    return !apart && ownReason(a) !== undefined && ownReason(b) !== undefined;
  };
  const clusters = mergeHomeDays(rolled, { evidence, cutAfter: edits.cutAfter });

  const kept: PlannedGroup[] = [];
  const loose: PlanItem[] = [];
  for (const cluster of clusters) {
    const members = cluster.items as PlanItem[];
    const first = position.get(members[0].id)!;
    const last = position.get(members[members.length - 1].id)!;
    const edited = cut.has(first) || cut.has(last + 1) || [...keep].some((i) => i > first && i <= last);
    const reason = ownReason(cluster) ?? (edited ? 'edited' : undefined);
    if (!reason || dismissed(members, edits.dismissals)) {
      loose.push(...members);
      continue;
    }
    kept.push({
      kind: cluster.kind === 'trip' ? 'trip' : 'event',
      items: members,
      shots: shotsOf(members),
      cluster,
      significance: { reason, baseline: baselines[dayOf(members[0]).slice(0, 4)] ?? 1 },
    });
  }
  return { kept, loose, baselines, dayShots, segments: segmentsOf(sorted, keep) };
};

// ── the plan ────────────────────────────────────────────────────────────────

/** The folders an item lies in below the category, outermost first, by name. */
const folderNamesOf = (item: PlanItem, folders: ReadonlyMap<string, PlanFolder>): string[] => {
  const folder = folders.get(item.folderId);
  if (!folder) return [];
  const segments = folder.path.split('/');
  return segments.slice(segments.length - folder.depth);
};

/**
 * The seeds of `items`: each folder below a batch (two or more levels under the category), or
 * titled by an import, holding at least three items, whose name a person gave it. A seed a person
 * dismissed is none.
 */
const findSeeds = (items: PlanItem[], ctx: PlanContext, dismissals: Set<string>[]): Map<string, PlanItem[]> => {
  const byFolder = new Map<string, PlanItem[]>();
  for (const item of items) pushTo(byFolder, item.folderId, item);
  const seeds = new Map<string, PlanItem[]>();
  for (const [folderId, inFolder] of byFolder) {
    const seed = ctx.seedFolders ? ctx.seedFolders.has(folderId) : isSeed(ctx.folders.get(folderId), inFolder, dismissals);
    if (seed) seeds.set(folderId, inFolder);
  }
  return seeds;
};

/** Whether a folder's name may make it a seed: an import titled it, or it lies below a batch and a person named it. */
export const isNameable = (folder: PlanFolder): boolean => folder.title !== undefined || (folder.depth >= 2 && !isMachineName(folder.name));

/** Whether `folder`, holding the items `inFolder` (all of them a plan has), is a seed (`findSeeds`). */
const isSeed = (folder: PlanFolder | undefined, inFolder: PlanItem[], dismissals: Set<string>[]): boolean =>
  folder !== undefined && inFolder.length >= SEED_MIN && isNameable(folder) && !dismissed(inFolder, dismissals);

/** Whether `folder`, holding the items `inFolder` (all of them a plan has), is a seed under the live edits `edits`. */
export const isSeedFolder = (folder: PlanFolder, inFolder: PlanItem[], edits: StagingEdit[]): boolean => isSeed(folder, inFolder, editSets(edits).dismissals);

/**
 * Which part of a plan of a timeline strategy an item (not in a seed) falls to: a clutter lane
 * (`events` only), the timeline (or with `none`, its month's lane), a period lane, or an undated
 * lane. Depends on the item and its folders alone.
 */
export const classOf = (item: PlanItem, ctx: Pick<PlanContext, 'strategy' | 'folders'>): 'clutter' | 'timeline' | 'period' | 'undated' => {
  // The phone folder a Takeout names counts as one of the item's folders: `WhatsApp Images`.
  const folderNames = [...folderNamesOf(item, ctx.folders), ...(item.localFolder ? [item.localFolder] : [])];
  if (ctx.strategy === 'events' && classifyItem({ ...item, devicePath: item.device, folderNames })) return 'clutter';
  if (item.precision === 'none') return 'undated';
  if (item.precision !== 'instant') return 'period';
  return 'timeline';
};

/**
 * The plan of one category: every item in exactly one group. `items` are the category's indexed
 * media but those a pinned group holds; or, planning part of a category, every item of the parts
 * planned (whole segments of the timeline, whole seed folders, whole lanes), with the seeds, the
 * other days' shots and the lanes' members left as they are given in `ctx`.
 */
export const planCategory = (items: PlanItem[], ctx: PlanContext): Plan => {
  const granularity: Record<string, 'year' | 'month'> = { ...ctx.granularity };
  let baselines: Record<string, number> = {};
  let dayShots: Record<string, number> = {};
  let segments: Segment[] = [];
  const seedFolders: string[] = [];
  const edits = editSets(ctx.edits);
  const groups: PlannedGroup[] = [];

  if (ctx.strategy === 'folders') {
    const byFolder = new Map<string, PlanItem[]>();
    for (const item of items) pushTo(byFolder, item.folderId, item);
    for (const [folderId, inFolder] of byFolder) {
      const label = folderNamesOf(inFolder[0], ctx.folders).join(' · ') || inFolder[0].folder.split('/').pop() || '';
      for (const run of folderRuns(inFolder, edits.cutAfter)) {
        const manual = run.map(yearOfManual).filter((year): year is string => year !== undefined).sort();
        const years = manual.length >= 0.6 * run.length && manual.length > 0 ? (manual[0] === manual.at(-1) ? manual[0] : `${manual[0]}–${manual.at(-1)}`) : undefined;
        groups.push({ kind: 'folder', items: run, shots: run.length, folderId, run: { label, ...(years ? { years } : {}) } });
      }
    }
  } else {
    let rest = items;
    if (ctx.strategy === 'events') {
      const seeds = findSeeds(items, ctx, edits.dismissals);
      seedFolders.push(...seeds.keys());
      for (const [folderId, members] of seeds) {
        const folder = ctx.folders.get(folderId)!;
        // Those with an instant in time order, then the others by name: an order whatever the items came in.
        const dated = members.filter((item) => item.precision === 'instant').sort(compareItems);
        const sorted = [...dated, ...members.filter((item) => item.precision !== 'instant').sort((a, b) => naturalCompare(a.name, b.name) || a.id.localeCompare(b.id))];
        groups.push({
          kind: 'seed',
          key: `seed:${folderId}`,
          items: sorted,
          shots: shotsOf(sorted.filter((item) => item.precision === 'instant')),
          folderId,
          seed: { source: folder.title !== undefined ? 'takeout-album' : 'folder', label: folder.title ?? folder.name },
          significance: { reason: 'seed', baseline: 1 },
        });
      }
      const seeded = new Set([...seeds.values()].flat().map((item) => item.id));
      rest = items.filter((item) => !seeded.has(item.id));
    }

    const parts = { clutter: [] as PlanItem[], timeline: [] as PlanItem[], period: [] as PlanItem[], undated: [] as PlanItem[] };
    const known: PlanItem[] = [];
    for (const item of rest) {
      const lane = ctx.strategy === 'events' ? ctx.lanes?.get(item.id) : undefined;
      if (lane === 'loose') known.push(item);
      else if (lane === 'clutter') parts.clutter.push(item);
      else parts[classOf(item, ctx)].push(item);
    }
    const { clutter, timeline, period, undated } = parts;

    if (ctx.strategy === 'events') {
      const planned = planTimeline(timeline, ctx, edits);
      ({ baselines, segments } = planned);
      dayShots = Object.fromEntries(planned.dayShots);
      groups.push(...planned.kept, ...datedLanes('loose', [...planned.loose, ...known], granularity));
      const [datedClutter, undatedClutter] = [clutter.filter((item) => item.precision !== 'none'), clutter.filter((item) => item.precision === 'none')];
      groups.push(...datedLanes('clutter', datedClutter, granularity));
      if (undatedClutter.length > 0) {
        groups.push(laneGroup('clutter', 'clutter:undated', undatedClutter.toSorted((a, b) => naturalCompare(a.name, b.name)), { kind: 'clutter' }));
      }
    } else {
      // `none`: a lane per folder and local month.
      const byKey = new Map<string, PlanItem[]>();
      for (const item of timeline.toSorted(compareItems)) {
        const key = `none:${item.folderId}:${dayOf(item).slice(0, 7)}`;
        pushTo(byKey, key, item);
      }
      for (const [key, inKey] of byKey) {
        chunkByDay(inKey).forEach((chunk, i) => {
          const folder = ctx.folders.get(chunk[0].folderId)?.name ?? '';
          const group = laneGroup('loose', `${key}${i > 0 ? `#${i + 1}` : ''}`, chunk, { kind: 'month', period: dayOf(chunk[0]).slice(0, 7), folder, chunk: i + 1 });
          group.folderId = chunk[0].folderId;
          groups.push(group);
        });
      }
    }
    groups.push(...folderLanes('period', period, ctx.folders), ...folderLanes('undated', undated, ctx.folders));
  }

  applyAssigns(groups, edits.assigns);
  return { groups: groups.filter((group) => group.items.length > 0), granularity, baselines, seeds: seedFolders, dayShots, segments };
};

/**
 * Move the items each assignment names into the group holding its `with`, oldest assignment first:
 * an item a person put with another stays with it. An assignment whose `with` is in no group does
 * nothing.
 */
const applyAssigns = (groups: PlannedGroup[], assigns: { items: string[]; with: string }[]): void => {
  if (assigns.length === 0) return;
  const holder = new Map<string, PlannedGroup>();
  for (const group of groups) for (const item of group.items) holder.set(item.id, group);
  for (const assign of assigns) {
    const into = holder.get(assign.with);
    if (!into) continue;
    for (const id of assign.items) {
      const from = holder.get(id);
      if (!from || from === into) continue;
      const index = from.items.findIndex((item) => item.id === id);
      const [item] = from.items.splice(index, 1);
      into.items.push(item);
      holder.set(id, into);
    }
  }
  for (const group of groups) {
    if (group.kind === 'event' || group.kind === 'trip' || group.kind === 'loose' || group.kind === 'clutter') {
      const dated = group.items.every((item) => item.precision !== 'none');
      if (dated) group.items.sort(compareItems);
    }
    group.shots = shotsOf(group.items.filter((item) => item.precision === 'instant').toSorted(compareItems));
  }
};
