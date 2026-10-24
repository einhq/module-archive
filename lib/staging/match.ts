/**
 * Matching: which library albums a suggested group (or any set of media) may belong in, with
 * reasons, a margin, and how likely a new album is instead (`@archive/staging/model`).
 *
 * **The profile index.** Every library album's profile (`@archive/media/album-profile`) is held in
 * the process, per VFS and reader, indexed by day, person, cell, location and prototype. It is
 * loaded whole by one query a page of a thousand and one batched read of their albums, brought up
 * to date on each use by one query for the profiles computed since, and loaded whole again every
 * hour so deleted albums leave it.
 *
 * **A subject's media** are read in batches across subjects: their nodes, signals (GPS, people,
 * locations), picture-vector ids and a sample of their vectors, each one lookup by id per thousand.
 *
 * **Candidates** (at most 30), in this order: albums holding a library copy of a member; albums
 * with a day within two days of the subject's (three for a trip), nearest first; albums whose
 * prototypes look like the subject's representative pictures; albums with its rarest people; albums
 * sharing a place with it that few albums share; albums whose title matches a seed's label. Each
 * is weighed on the evidence of `MatchEvidence`, and the candidates and a new album are one choice
 * (`@archive/staging/model`). An album with no evidence of time, place, people or copies is ranked
 * after every album that has some. An album the owner cannot read is never offered, and one
 * rejected for most of the subject's members (`staging reject`) is left out.
 *
 * `matchGroups` writes what it finds on each group as `stagingMatches`, stamped with the group's
 * member key; nothing is ever filed by it. An Everyday lane is matched a day at a time, on time,
 * place and people alone, and keeps the days likely to belong in an album (`days`).
 */
import type { Command, Node } from '@ein/client';
import { accessOfUser, verifyAccess } from '@ein/client';
import { dirname } from '@std/path';
import type { AlbumProfile } from '@archive/media/api';
import { albumsHolding } from '@archive/media/album-members';
import {
  cellAndNeighbours,
  cellOf,
  dayOfWall,
  majority,
  minuteOf,
  pictureVectorIds,
  PROFILE_ATTR,
  PROFILE_TYPE,
  readUnitVectors,
  representativesOf,
  sampleIds,
} from '@archive/media/album-profile';
import { quality, saysUnsorted } from '@archive/media/name-quality';
import { ALBUMS_ROOT } from '@archive/paths';
import type {
  GroupKind,
  MatchConfidence,
  MatchEvidence,
  StagingDayMatch,
  StagingMatchCandidate,
  StagingMatchDecision,
  StagingMatches,
  StagingMatchResult,
  StagingReject,
} from '@archive/staging/api';
import { AUTO_ORIGIN, type AutoAlbumMeta, COVER_LINK_NAME } from '@archive/staging/auto-album';
import { breadthOf, choiceOf, DAY_MATCH_P, logitOf, MATCH_MODEL, supportedBy, verdictOf, WEIGHTS } from '@archive/staging/model';
import { idsAt, nodesAt } from '@archive/staging/nodes-at';
import { categoryAlbumsPath, categoryPath, isStagingGroup, parseStagedPath, stagingRoots } from '@archive/staging/paths';
import { readSignals } from '@archive/staging/signals';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The attr a group's matches are kept in, and the one a rejection's journal entry carries. */
export const MATCHES_ATTR = 'stagingMatches';
export const REJECT_ATTR = 'stagingReject';

const IDS_PER_CALL = 1000;
const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY_MS = 86_400_000;
/** The whole index is loaded again this often. */
const FULL_RELOAD_MS = 60 * 60 * 1000;
/** Members one batch of subjects holds at most. */
const BATCH_MEMBERS = 2000;
const CANDIDATES_MAX = 30;
const STORED_MAX = 3;
const REASONS_MAX = 4;
/** Candidates by time: albums active this many days either side of the subject's days (a trip's: `TRIP_DAYS`). */
const NEAR_DAYS = 2;
const TRIP_DAYS = 3;
const TIME_CANDIDATES = 15;
/** Candidates by look: how many prototypes each representative is compared with, the least vote, and how many. */
const VISUAL_NEIGHBOURS = 21;
const VISUAL_MIN_VOTE = 0.3;
const VISUAL_CANDIDATES = 10;
const PEOPLE_CANDIDATES = 5;
const RAREST_PEOPLE = 3;
const PLACE_CANDIDATES = 5;
const TEXT_CANDIDATES = 5;
const TEXT_MIN_QUALITY = 0.8;
/** A cell held by more than this share of albums (home, the usual places) says nothing. */
const COMMON_CELL_SHARE = 0.05;
/** A subject's representative pictures, and the vectors they are found among. */
const REPRESENTATIVES = 3;
const REPRESENTATIVE_SAMPLE = 200;
/** Dated items the time evidence is taken over at most. */
const TIME_SAMPLE = 200;
/** How far apart in time still counts as near, by how many days the album is active on. */
const TAU_ONE_DAY = 3 * HOUR;
const TAU_WEEK = 12 * HOUR;
const TAU_LONGER = 24 * HOUR;
/** A rejection applies to a group at least this much of whose members it names. */
const REJECT_COVER = 0.5;
/** The days around an album's changed days whose groups are matched again after filing. */
const REMATCH_DAYS = 3;
/** Staged files read per query when finding the groups around some days, and at most in all. */
const AROUND_PAGE = 1000;
const AROUND_MAX = 5000;

const chunks = <T>(items: T[], size = IDS_PER_CALL): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ── the profile index ─────────────────────────────────────────────────────────

/** A library album as matching holds it. */
export type IndexedAlbum = {
  id: string;
  path: string;
  title: string;
  props: { uid: number; gid: number; mode: number };
  count?: number;
  profile: AlbumProfile;
  days: Set<string>;
  cells: Set<string>;
  locations: Set<string>;
  people: Set<string>;
};

/** Every profile, and what finds albums by day, person, cell, location and prototype. */
type ProfileIndex = {
  albums: Map<string, IndexedAlbum>;
  byPath: Map<string, string>;
  byDay: Map<string, string[]>;
  byPerson: Map<string, string[]>;
  byCell: Map<string, string[]>;
  byLocation: Map<string, string[]>;
  /** Prototype embedding ids, each with its album, by picture type. */
  prototypes: Map<string, Map<string, string>>;
};

type Cached = { index: ProfileIndex; loadedAt: number; seenUpTo: string };
const caches = new WeakMap<object, Map<number, Cached>>();

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** The finding maps of `albums`. */
export const indexOf = (albums: Map<string, IndexedAlbum>): ProfileIndex => {
  const index: ProfileIndex = { albums, byPath: new Map(), byDay: new Map(), byPerson: new Map(), byCell: new Map(), byLocation: new Map(), prototypes: new Map() };
  for (const album of albums.values()) {
    index.byPath.set(album.path, album.id);
    for (const day of album.days) push(index.byDay, day, album.id);
    for (const person of album.people) push(index.byPerson, person, album.id);
    for (const cell of album.cells) push(index.byCell, cell, album.id);
    for (const location of album.locations) push(index.byLocation, location, album.id);
    const type = album.profile.pictureType;
    if (type) {
      let typed = index.prototypes.get(type);
      if (!typed) index.prototypes.set(type, typed = new Map());
      for (const id of album.profile.prototypes) typed.set(id, album.id);
    }
  }
  return index;
};

/** An album and its profile as the index holds them. */
export const indexedAlbum = (album: { id: string; path: string; title: string; props: IndexedAlbum['props']; count?: number }, profile: AlbumProfile): IndexedAlbum => ({
  ...album,
  profile,
  days: new Set(profile.days.map(([day]) => day)),
  cells: new Set(profile.cells.map(([cell]) => cell)),
  locations: new Set(profile.locations.map(([location]) => location)),
  people: new Set(profile.people.map(([person]) => person)),
});

/** The profiles computed since `since` (all of them without), with their albums, as the reader sees them. */
const readProfiles = async (vfs: Vfs, access: Access, since?: string): Promise<IndexedAlbum[]> => {
  const rows: { path: string; profile: AlbumProfile }[] = [];
  let after: { value: string | null; id: string } | undefined;
  while (true) {
    const page = await vfs.query(access, {
      types: [PROFILE_TYPE],
      ...(since ? { where: [{ ref: { path: [PROFILE_ATTR, 'computedAt'] }, op: 'gte' as const, value: since }] } : {}),
      ...(after ? { after } : {}),
      limit: IDS_PER_CALL,
    });
    for (const row of page) {
      const profile = row.node.attrs[PROFILE_ATTR] as AlbumProfile | undefined;
      if (profile?.version === 1 && row.absPath.startsWith(`${ALBUMS_ROOT}/`)) rows.push({ path: dirname(row.absPath), profile });
    }
    if (page.length < IDS_PER_CALL) break;
    after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
  }
  if (rows.length === 0) return [];
  const albums = await nodesAt(vfs, access, rows.map((row) => row.path));
  return rows.flatMap(({ path, profile }) => {
    const node = albums.get(path);
    if (node?.type !== 'album' || node.attrs.origin === AUTO_ORIGIN) return [];
    const name = node.attrs.name;
    return [indexedAlbum({
      id: node.id,
      path,
      title: typeof name === 'string' && name ? name : path.slice(path.lastIndexOf('/') + 1),
      props: { uid: node.props.uid, gid: node.props.gid, mode: node.props.mode },
      ...(typeof node.attrs.mediaCount === 'number' ? { count: node.attrs.mediaCount } : {}),
    }, profile)];
  });
};

/**
 * The profile index for `access` on `vfs`: loaded whole the first time and every hour, otherwise
 * brought up to date with the profiles computed since it last looked.
 */
export const profileIndex = async (vfs: Vfs, access: Access): Promise<ProfileIndex> => {
  let byReader = caches.get(vfs);
  if (!byReader) caches.set(vfs, byReader = new Map());
  const cached = byReader.get(access.uid);
  const now = Date.now();
  if (!cached || now - cached.loadedAt > FULL_RELOAD_MS) {
    const albums = await readProfiles(vfs, access);
    const fresh: Cached = {
      index: indexOf(new Map(albums.map((album) => [album.id, album]))),
      loadedAt: now,
      seenUpTo: albums.reduce((latest, album) => album.profile.computedAt > latest ? album.profile.computedAt : latest, ''),
    };
    byReader.set(access.uid, fresh);
    return fresh.index;
  }
  const changed = cached.seenUpTo ? await readProfiles(vfs, access, cached.seenUpTo) : await readProfiles(vfs, access);
  const updates = changed.filter((album) => cached.index.albums.get(album.id)?.profile.computedAt !== album.profile.computedAt);
  if (updates.length === 0) return cached.index;
  const albums = new Map(cached.index.albums);
  for (const album of updates) {
    albums.set(album.id, album);
    if (album.profile.computedAt > cached.seenUpTo) cached.seenUpTo = album.profile.computedAt;
  }
  cached.index = indexOf(albums);
  return cached.index;
};

// ── subjects ──────────────────────────────────────────────────────────────────

/** One medium as matching weighs it. */
type Item = {
  id: string;
  path: string;
  /** Its capture instant in epoch minutes, when known to the day or better. */
  minute?: number;
  /** Its wall-clock day. */
  day?: string;
  /** The period a year- or month-dated medium was taken in, in epoch minutes, end exclusive. */
  period?: [number, number];
  cell?: string;
  location?: string;
  persons: string[];
  /** The library original it is an exact copy of, by id. */
  copyOf?: string;
  /** Its picture vector's embedding id. */
  vector?: string;
};

/** What is matched: a group, a file or a set of media, and what is known of it. */
export type Subject = {
  path: string;
  kind: 'group' | 'file' | 'set';
  groupKind?: GroupKind;
  /** A seed's label, which album titles are compared with. */
  label?: string;
  items: Item[];
};

type FileAttrs = { takenAt?: string; takenAtUtc?: string; duplicate?: { kind?: string; where?: string; of?: string } };

/** The period of a year- or month-dated wall clock, in epoch minutes. */
const periodOf = (takenAt: string | undefined, takenAtUtc: string | undefined): [number, number] | undefined => {
  if (!takenAtUtc || typeof takenAt !== 'string') return undefined;
  const year = /^(\d{4})$/.exec(takenAt);
  if (year) return [Date.UTC(Number(year[1]), 0, 1) / 60_000, Date.UTC(Number(year[1]) + 1, 0, 1) / 60_000];
  const month = /^(\d{4})-(\d{2})$/.exec(takenAt);
  if (month) return [Date.UTC(Number(month[1]), Number(month[2]) - 1, 1) / 60_000, Date.UTC(Number(month[1]), Number(month[2]), 1) / 60_000];
  return undefined;
};

/** The location ids of location paths read so far in a run. */
type LocationIds = Map<string, string | undefined>;

/** Each of `files` (by id, with its path and attrs) as an item: its signals, location and picture vector in batched lookups. */
export const readItems = async (
  vfs: Vfs,
  access: Access,
  files: Map<string, { path: string; attrs: FileAttrs }>,
  locationIds: LocationIds = new Map(),
): Promise<Map<string, Item>> => {
  const ids = [...files.keys()];
  const signals = await readSignals(vfs, access, ids);
  const vectors = await pictureVectorIds(vfs, access, ids);
  const unresolved = [...new Set([...signals.values()].flatMap((signal) => signal.location ?? []))].filter((path) => !locationIds.has(path));
  if (unresolved.length > 0) {
    const found = await idsAt(vfs, access, unresolved);
    for (const path of unresolved) locationIds.set(path, found.get(path));
  }
  const items = new Map<string, Item>();
  for (const [id, { path, attrs }] of files) {
    const signal = signals.get(id);
    const day = dayOfWall(attrs.takenAt);
    const minute = day ? minuteOf(attrs.takenAtUtc) : undefined;
    const period = minute === undefined ? periodOf(attrs.takenAt, attrs.takenAtUtc) : undefined;
    const location = signal?.location ? locationIds.get(signal.location) : undefined;
    const copy = attrs.duplicate;
    items.set(id, {
      id,
      path,
      ...(minute !== undefined ? { minute, day } : {}),
      ...(period ? { period } : {}),
      ...(signal?.point ? { cell: cellOf(signal.point) } : {}),
      ...(location ? { location } : {}),
      persons: signal?.persons ?? [],
      ...(copy?.where === 'library' && copy.kind === 'exact' && typeof copy.of === 'string' ? { copyOf: copy.of } : {}),
      ...(vectors.get(id) ? { vector: vectors.get(id) } : {}),
    });
  }
  return items;
};

// ── evidence ──────────────────────────────────────────────────────────────────

/** The index of the first of sorted `values` at or after `value`. */
const lowerBound = (values: readonly number[], value: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** How near in time counts as near for an album active on `activeDays` days, in minutes. */
const tauOf = (activeDays: number): number => activeDays <= 1 ? TAU_ONE_DAY : activeDays <= 7 ? TAU_WEEK : TAU_LONGER;

/** The distance from `minute` to the nearest of sorted `times`, in minutes. */
const nearest = (times: readonly number[], minute: number): number => {
  const at = lowerBound(times, minute);
  let best = Infinity;
  if (at < times.length) best = times[at] - minute;
  if (at > 0) best = Math.min(best, minute - times[at - 1]);
  return best;
};

/**
 * Time evidence: the mean over the dated items (at most `TIME_SAMPLE`, spread evenly) of
 * exp(−Δ/τ), Δ the distance to the album's nearest instant; an item dated only to a year or a
 * month counts half when an album instant falls in its period. Absent when either side has no
 * times.
 */
export const timeEvidence = (items: readonly Pick<Item, 'minute' | 'period'>[], times: readonly number[], activeDays: number): number | undefined => {
  const dated = items.filter((item) => item.minute !== undefined || item.period);
  if (dated.length === 0 || times.length === 0) return undefined;
  const sample = dated.length <= TIME_SAMPLE ? dated : Array.from({ length: TIME_SAMPLE }, (_, i) => dated[Math.floor((i * dated.length) / TIME_SAMPLE)]);
  const tau = tauOf(activeDays);
  let sum = 0;
  for (const item of sample) {
    if (item.minute !== undefined) sum += Math.exp(-nearest(times, item.minute) / tau);
    else if (item.period) {
      const at = lowerBound(times, item.period[0]);
      if (at < times.length && times[at] < item.period[1]) sum += 0.5;
    }
  }
  return sum / sample.length;
};

/**
 * Place evidence: over the subject's located items, Σ idf(token)·[the album has it] / Σ idf(token),
 * a token being an item's cell (the album's cell or one of its eight neighbours counts) and its
 * location. A token `idf` gives no weight (a place most albums share) counts for nothing. Absent
 * when no token weighs anything, or the album has no places.
 */
export const placeEvidence = (
  items: readonly Pick<Item, 'cell' | 'location'>[],
  album: { cells: ReadonlySet<string>; locations: ReadonlySet<string> },
  idf: { cell: (cell: string) => number; location: (location: string) => number },
): number | undefined => {
  if (album.cells.size === 0 && album.locations.size === 0) return undefined;
  let total = 0;
  let held = 0;
  for (const item of items) {
    if (item.cell) {
      const weight = idf.cell(item.cell);
      total += weight;
      if (weight > 0 && cellAndNeighbours(item.cell).some((cell) => album.cells.has(cell))) held += weight;
    }
    if (item.location) {
      const weight = idf.location(item.location);
      total += weight;
      if (weight > 0 && album.locations.has(item.location)) held += weight;
    }
  }
  return total > 0 ? held / total : undefined;
};

/**
 * People evidence: Σ over the subject's people the album has of idf(p), over Σ of idf(p) over all
 * of them: containment, so two guests of an album of many score high. Absent when either side has
 * nobody.
 */
export const peopleEvidence = (persons: ReadonlySet<string>, albumPeople: ReadonlySet<string>, idf: (person: string) => number): number | undefined => {
  if (persons.size === 0 || albumPeople.size === 0) return undefined;
  let total = 0;
  let held = 0;
  for (const person of persons) {
    const weight = idf(person);
    total += weight;
    if (albumPeople.has(person)) held += weight;
  }
  return total > 0 ? held / total : undefined;
};

/**
 * The votes of ranked similarities (best first): each clamp((cosₖ − cos_last)/(cos₁ − cos_last +
 * 0.01), 0, 1), so what counts is how far above the field a prototype stands, and high cosines
 * with no spread give no votes.
 */
export const voteOf = (similarity: number, best: number, last: number): number => Math.min(1, Math.max(0, (similarity - last) / (best - last + 0.01)));

/** The inverse frequency of something `holders` of `total` albums have: ln(1 + total / holders). */
const idfOf = (total: number, holders: number): number => Math.log(1 + total / Math.max(1, holders));

// ── ranking ───────────────────────────────────────────────────────────────────

/** One album weighed for a subject, by its logit. */
type Weighed = { albumId: string; logit: number; evidence: MatchEvidence; reasons: string[] };

/**
 * Each candidate's margin over the next, in their order: what it is ahead by, never below 0, and 0
 * for one with no evidence of time, place, people or copies, which is never sure of anything.
 */
const withMargins = <T extends { score: number; evidence: MatchEvidence }>(ordered: T[]): (T & { margin: number })[] =>
  ordered.map((each, i) => ({ ...each, margin: supportedBy(each.evidence) ? round3(Math.max(0, each.score - (ordered[i + 1]?.score ?? 0))) : 0 }));

/**
 * The weighed albums as one choice with a new album: the best `max` as stored, those with evidence
 * of time, place, people or copies first, each by its probability, with its margin over the next
 * (the last over none); and how likely a new album is.
 */
export const rankCandidates = (
  weighed: Weighed[],
  writable: (albumId: string) => boolean,
  max = STORED_MAX,
): { candidates: StagingMatchCandidate[]; newAlbum: number } => {
  const { p, none } = choiceOf(weighed.map((each) => each.logit));
  const scored = weighed.map((each, i) => ({ ...each, p: p[i], supported: supportedBy(each.evidence) }));
  const sorted = scored.sort((a, b) => Number(b.supported) - Number(a.supported) || b.p - a.p || (a.albumId < b.albumId ? -1 : 1));
  const candidates = withMargins(
    sorted.slice(0, max + 1).map((each) => ({
      albumId: each.albumId,
      score: round3(each.p),
      reasons: each.reasons,
      evidence: roundEvidence(each.evidence),
      writable: writable(each.albumId),
    })),
  ).slice(0, max);
  return { candidates, newAlbum: round3(none) };
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const roundEvidence = (evidence: MatchEvidence): MatchEvidence => Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, round3(value as number)]));

/** Whether a rejection names at least half of `members`. */
export const rejectsFor = (members: readonly string[], rejects: readonly StagingReject[]): Set<string> => {
  const out = new Set<string>();
  if (members.length === 0) return out;
  for (const reject of rejects) {
    const named = new Set(reject.members);
    const covered = members.filter((id) => named.has(id)).length;
    if (covered >= REJECT_COVER * members.length) out.add(reject.album);
  }
  return out;
};

/** A duration in words: minutes, hours or days. */
const duration = (minutes: number): string => {
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 36 * HOUR) return `${Math.round(minutes / HOUR)} h`;
  return `${Math.round(minutes / (24 * HOUR))} days`;
};

/** What the evidence says, in words that name no one, strongest first, at most `REASONS_MAX`. */
const reasonsOf = (
  evidence: MatchEvidence,
  detail: { near?: { minutes: number; items: number; dated: number }; place?: { held: number; located: number }; people?: { held: number; all: number }; copies?: number },
): string[] => {
  const said: { weight: number; text: string }[] = [];
  const say = (key: keyof MatchEvidence, text: string | undefined) => {
    const value = evidence[key];
    if (text && value !== undefined && WEIGHTS[key] * value > 0) said.push({ weight: WEIGHTS[key] * value, text });
  };
  if (detail.near) say('time', `within ${duration(detail.near.minutes)} of its photos for ${detail.near.items} of ${detail.near.dated}`);
  if (detail.place) say('place', `same places for ${detail.place.held} of ${detail.place.located} located photos`);
  if (detail.people) say('people', `${detail.people.held} of ${detail.people.all} people appear in it`);
  if ((evidence.visual ?? 0) >= 0.5) say('visual', 'looks alike');
  if (detail.copies) say('duplicate', `${detail.copies} exact ${detail.copies === 1 ? 'copy is' : 'copies are'} in it`);
  if ((evidence.text ?? 0) >= TEXT_MIN_QUALITY) say('text', 'its name matches the folder');
  return said.sort((a, b) => b.weight - a.weight).slice(0, REASONS_MAX).map((each) => each.text);
};

// ── weighing a subject ────────────────────────────────────────────────────────

/** What one weighing of subjects shares: the index, whose eyes albums are judged through, and the run's lookups. */
export type MatchContext = {
  cmd: Command;
  index: ProfileIndex;
  /** The access albums must be readable (and are marked writable) by: the owner of what is matched. */
  owner: Access;
  /** Only albums under this path are offered. */
  root?: string;
  /** Albums the visual stage leaves alone (their prototypes stand for media being held out). */
  noVisual?: ReadonlySet<string>;
};

/** The albums `context` may offer, by id. */
const offered = (context: MatchContext, albumId: string): IndexedAlbum | undefined => {
  const album = context.index.albums.get(albumId);
  if (!album) return undefined;
  if (context.root && !album.path.startsWith(`${context.root}/`)) return undefined;
  return verifyAccess(context.owner, album.props, 'r') ? album : undefined;
};

/** Each subject's representative vectors: a sample of its members' vectors, and the members nearest their k-means centres. */
const representativesFor = async (vfs: Vfs, access: Access, subjects: Subject[]): Promise<Map<string, { type: string; vectors: Uint8Array[] }>> => {
  const samples = new Map(subjects.map((subject) => [subject.path, sampleIds(subject.items.flatMap((item) => item.vector ?? []), REPRESENTATIVE_SAMPLE, subject.path)]));
  const vectors = await readUnitVectors(vfs, access, [...new Set([...samples.values()].flat())]);
  const out = new Map<string, { type: string; vectors: Uint8Array[] }>();
  for (const subject of subjects) {
    const sample = (samples.get(subject.path) ?? []).flatMap((id) => vectors.get(id) ? [{ id, ...vectors.get(id)! }] : []);
    const type = majority(sample.map((each) => each.type));
    if (!type) continue;
    const typed = sample.filter((each) => each.type === type);
    const chosen = representativesOf(typed.map(({ id, vector }) => ({ id, vector })), REPRESENTATIVES, subject.path);
    const encoder = new TextEncoder();
    out.set(subject.path, { type, vectors: chosen.map((id) => encoder.encode(JSON.stringify(Array.from(typed.find((each) => each.id === id)!.vector)))) });
  }
  return out;
};

/** The library albums holding a copy of each original (by id): one path lookup and one backlink read for them all. */
const albumsOfCopies = async (context: MatchContext, originals: string[]): Promise<Map<string, Set<string>>> => {
  const out = new Map<string, Set<string>>();
  if (originals.length === 0) return out;
  const { cmd, index } = context;
  const paths = await cmd.sys.vfs.resolveIdPaths(cmd.access, originals);
  const byPath = new Map<string, string>();
  for (const [id, each] of paths) for (const path of each) byPath.set(path, id);
  const holding = await albumsHolding(cmd, [...byPath.keys()], new Set(index.byPath.keys()));
  for (const [path, albums] of holding) {
    const id = byPath.get(path)!;
    const set = out.get(id) ?? new Set<string>();
    for (const album of albums) {
      const albumId = index.byPath.get(album);
      if (albumId) set.add(albumId);
    }
    out.set(id, set);
  }
  return out;
};

/** How a subject's days and places look to the index, shared by its whole weighing and its days'. */
type SubjectFacts = {
  days: string[];
  dated: number;
  persons: Set<string>;
  located: number;
};

const factsOf = (items: readonly Item[]): SubjectFacts => ({
  days: [...new Set(items.flatMap((item) => item.day ?? []))].sort(),
  dated: items.filter((item) => item.minute !== undefined || item.period).length,
  persons: new Set(items.flatMap((item) => item.persons)),
  located: items.filter((item) => item.cell || item.location).length,
});

/** The albums active within `spread` days of `days`, nearest first, at most `max`. */
const nearInTime = (context: MatchContext, days: readonly string[], spread: number, max: number): string[] => {
  const distance = new Map<string, number>();
  for (const day of days) {
    for (let offset = -spread; offset <= spread; offset++) {
      for (const albumId of context.index.byDay.get(addDays(day, offset)) ?? []) {
        const now = distance.get(albumId);
        if (now === undefined || Math.abs(offset) < now) distance.set(albumId, Math.abs(offset));
      }
    }
  }
  return [...distance].filter(([albumId]) => offered(context, albumId)).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([albumId]) => albumId);
};

/** The weighing of `items` against one album, with what its reasons say. */
const weigh = (
  context: MatchContext,
  album: IndexedAlbum,
  items: readonly Item[],
  facts: SubjectFacts,
  extra: { visual?: number; copies?: { count: number; of: number }; text?: number },
  seen: boolean,
): Weighed => {
  const { index } = context;
  const total = index.albums.size;
  const commonCells = COMMON_CELL_SHARE * total;
  const evidence: MatchEvidence = {};
  const time = timeEvidence(items, album.profile.times, album.profile.activeDays);
  let near: { minutes: number; items: number; dated: number } | undefined;
  if (time !== undefined) {
    evidence.time = time;
    const tau = tauOf(album.profile.activeDays);
    const distances = items.flatMap((item) => item.minute === undefined ? [] : [nearest(album.profile.times, item.minute)]).filter((d) => d <= 2 * tau).sort((a, b) => a - b);
    if (distances.length > 0) near = { minutes: distances[distances.length - 1], items: distances.length, dated: facts.dated };
  }
  const cellIdf = (cell: string) => {
    const holders = index.byCell.get(cell)?.length ?? 0;
    return holders > commonCells && holders > 1 ? 0 : idfOf(total, holders);
  };
  const locationIdf = (location: string) => {
    const holders = index.byLocation.get(location)?.length ?? 0;
    return holders > commonCells && holders > 1 ? 0 : idfOf(total, holders);
  };
  const place = placeEvidence(items, album, { cell: cellIdf, location: locationIdf });
  let placeDetail: { held: number; located: number } | undefined;
  if (place !== undefined) {
    evidence.place = place;
    const held = items.filter((item) =>
      (item.cell && cellAndNeighbours(item.cell).some((cell) => album.cells.has(cell))) || (item.location && album.locations.has(item.location))
    ).length;
    placeDetail = { held, located: facts.located };
  }
  const people = peopleEvidence(facts.persons, album.people, (person) => idfOf(total, index.byPerson.get(person)?.length ?? 0));
  let peopleDetail: { held: number; all: number } | undefined;
  if (people !== undefined) {
    evidence.people = people;
    peopleDetail = { held: [...facts.persons].filter((person) => album.people.has(person)).length, all: facts.persons.size };
  }
  if (extra.visual !== undefined) evidence.visual = extra.visual;
  if (extra.copies && extra.copies.of > 0) evidence.duplicate = extra.copies.count / extra.copies.of;
  if (extra.text !== undefined) evidence.text = extra.text;
  if (album.profile.dated > 0) evidence.breadth = breadthOf(album.profile.spanDays);
  if (saysUnsorted(album.title)) evidence.unsorted = 1;
  return {
    albumId: album.id,
    logit: logitOf(evidence, seen),
    evidence,
    reasons: reasonsOf(evidence, { near, place: placeDetail, people: peopleDetail, copies: extra.copies?.count }),
  };
};

/** What weighing one subject found: every candidate weighed, and whether pictures were compared. */
type Weighing = { weighed: Weighed[]; visual: boolean };

/**
 * Weigh `subjects` against the library: the candidates of each, gathered as the file's header
 * says, and the evidence for each. `rejected` gives the albums a subject must not be offered.
 */
export const weighSubjects = async (
  context: MatchContext,
  subjects: Subject[],
  rejected: (subject: Subject) => ReadonlySet<string> = () => new Set(),
): Promise<Map<string, Weighing>> => {
  const { cmd, index } = context;
  const { vfs } = cmd.sys;
  const representatives = await representativesFor(vfs, cmd.access, subjects);
  const copies = await albumsOfCopies(context, [...new Set(subjects.flatMap((subject) => subject.items.flatMap((item) => item.copyOf ?? [])))]);
  const out = new Map<string, Weighing>();

  for (const subject of subjects) {
    const facts = factsOf(subject.items);
    const refused = rejected(subject);
    const candidates: string[] = [];
    const add = (albumIds: Iterable<string>, max: number) => {
      let taken = 0;
      for (const albumId of albumIds) {
        if (candidates.length >= CANDIDATES_MAX || taken >= max) return;
        if (candidates.includes(albumId) || refused.has(albumId) || !offered(context, albumId)) continue;
        candidates.push(albumId);
        taken++;
      }
    };

    // Copies: how many of the subject's media each album holds a copy of.
    const copyCounts = new Map<string, number>();
    for (const item of subject.items) {
      for (const albumId of item.copyOf ? copies.get(item.copyOf) ?? [] : []) copyCounts.set(albumId, (copyCounts.get(albumId) ?? 0) + 1);
    }
    const withCopies = subject.items.filter((item) => item.copyOf).length;
    add([...copyCounts].sort((a, b) => b[1] - a[1]).map(([albumId]) => albumId), CANDIDATES_MAX);

    add(nearInTime(context, facts.days, subject.groupKind === 'trip' ? TRIP_DAYS : NEAR_DAYS, TIME_CANDIDATES), TIME_CANDIDATES);

    // Looks: each representative against every prototype of its type; the albums whose
    // prototypes stand out, then every candidate's prototypes on the same scale.
    const looks = representatives.get(subject.path);
    const typed = looks ? index.prototypes.get(looks.type) : undefined;
    const visualVotes = new Map<string, number[]>();
    const scales: { best: number; last: number }[] = [];
    if (looks && typed && typed.size > 0) {
      const within = [...typed].filter(([, albumId]) => !context.noVisual?.has(albumId) && offered(context, albumId)).map(([id]) => id);
      if (within.length > 0) {
        for (const vector of looks.vectors) {
          const hits = await vfs.findSimilar(cmd.access, looks.type, vector, VISUAL_NEIGHBOURS, -1, within);
          if (hits.length === 0) continue;
          const scale = { best: hits[0].similarity, last: hits[hits.length - 1].similarity };
          scales.push(scale);
          const best = new Map<string, number>();
          for (const hit of hits) {
            const albumId = typed.get(hit.id);
            if (albumId) best.set(albumId, Math.max(best.get(albumId) ?? 0, voteOf(hit.similarity, scale.best, scale.last)));
          }
          for (const [albumId, vote] of best) visualVotes.set(albumId, [...visualVotes.get(albumId) ?? [], vote]);
        }
        const mean = (votes: number[]) => votes.reduce((sum, vote) => sum + vote, 0) / Math.max(1, looks.vectors.length);
        add(
          [...visualVotes].map(([albumId, votes]) => [albumId, mean(votes)] as const).filter(([, vote]) => vote >= VISUAL_MIN_VOTE).sort((a, b) => b[1] - a[1]).map((
            [albumId],
          ) => albumId),
          VISUAL_CANDIDATES,
        );
      }
    }

    // People: the albums holding the subject's rarest people.
    const rarest = [...facts.persons].sort((a, b) => (index.byPerson.get(a)?.length ?? 0) - (index.byPerson.get(b)?.length ?? 0)).slice(0, RAREST_PEOPLE);
    const peopleCounts = new Map<string, number>();
    for (const person of rarest) for (const albumId of index.byPerson.get(person) ?? []) peopleCounts.set(albumId, (peopleCounts.get(albumId) ?? 0) + 1);
    add([...peopleCounts].sort((a, b) => b[1] - a[1]).map(([albumId]) => albumId), PEOPLE_CANDIDATES);

    // Places few albums share.
    const placeCounts = new Map<string, number>();
    const commonCells = COMMON_CELL_SHARE * index.albums.size;
    for (const item of subject.items) {
      for (const cell of item.cell ? cellAndNeighbours(item.cell) : []) {
        const holders = index.byCell.get(cell) ?? [];
        if (holders.length > commonCells && holders.length > 1) continue;
        for (const albumId of holders) placeCounts.set(albumId, (placeCounts.get(albumId) ?? 0) + 1);
      }
      for (const albumId of item.location ? index.byLocation.get(item.location) ?? [] : []) placeCounts.set(albumId, (placeCounts.get(albumId) ?? 0) + 1);
    }
    add([...placeCounts].sort((a, b) => b[1] - a[1]).map(([albumId]) => albumId), PLACE_CANDIDATES);

    // A seed's label against album titles.
    const label = subject.label?.trim().toLowerCase();
    const textQuality = new Map<string, number>();
    if (label) {
      for (const album of index.albums.values()) {
        const value = quality(label, album.title);
        if (value >= TEXT_MIN_QUALITY) textQuality.set(album.id, value);
      }
      add([...textQuality].sort((a, b) => b[1] - a[1]).map(([albumId]) => albumId), TEXT_CANDIDATES);
    }

    // Every candidate's prototypes, ranked for each representative on that representative's scale.
    let visual = false;
    const candidateVotes = new Map<string, number[]>();
    if (looks && typed && scales.length > 0) {
      const prototypes = candidates.flatMap((albumId) =>
        context.noVisual?.has(albumId) ? [] : index.albums.get(albumId)?.profile.pictureType === looks.type ? index.albums.get(albumId)!.profile.prototypes : []
      );
      if (prototypes.length > 0) {
        visual = true;
        for (const [i, vector] of looks.vectors.entries()) {
          const scale = scales[Math.min(i, scales.length - 1)];
          const hits = await vfs.findSimilar(cmd.access, looks.type, vector, prototypes.length, -1, prototypes);
          const best = new Map<string, number>();
          for (const hit of hits) {
            const albumId = typed.get(hit.id);
            if (albumId) best.set(albumId, Math.max(best.get(albumId) ?? 0, voteOf(hit.similarity, scale.best, scale.last)));
          }
          for (const albumId of candidates) candidateVotes.set(albumId, [...candidateVotes.get(albumId) ?? [], best.get(albumId) ?? 0]);
        }
      }
    }

    const weighed = candidates.map((albumId) => {
      const album = index.albums.get(albumId)!;
      const votes = candidateVotes.get(albumId);
      const hasPrototypes = album.profile.pictureType === looks?.type && album.profile.prototypes.length > 0 && !context.noVisual?.has(albumId);
      return weigh(context, album, subject.items, facts, {
        ...(visual && votes && hasPrototypes ? { visual: votes.reduce((sum, vote) => sum + vote, 0) / votes.length } : {}),
        ...(withCopies > 0 ? { copies: { count: copyCounts.get(albumId) ?? 0, of: withCopies } } : {}),
        ...(label ? { text: textQuality.get(albumId) ?? quality(label, album.title) } : {}),
      }, visual);
    });
    out.set(subject.path, { weighed, visual });
  }
  return out;
};

/**
 * Each day of `items` (a lane's) matched on time, place and people alone against the albums active
 * near it, as one choice: the best album at least `DAY_MATCH_P` likely, with the day's media.
 * `rejected` albums are passed over.
 */
const matchDays = (context: MatchContext, items: readonly Item[], rejected: ReadonlySet<string>): StagingDayMatch[] => {
  const byDay = new Map<string, Item[]>();
  for (const item of items) if (item.day) push(byDay, item.day, item);
  const out: StagingDayMatch[] = [];
  for (const [day, dayItems] of [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const facts = factsOf(dayItems);
    const weighed = nearInTime(context, [day], NEAR_DAYS, TIME_CANDIDATES).filter((albumId) => !rejected.has(albumId))
      .map((albumId) => weigh(context, context.index.albums.get(albumId)!, dayItems, facts, {}, false));
    const best = rankCandidates(weighed, () => true, 1).candidates[0];
    if (best && best.score >= DAY_MATCH_P && supportedBy(best.evidence)) out.push({ day, albumId: best.albumId, score: best.score, files: dayItems.length });
  }
  return out;
};

// ── groups ────────────────────────────────────────────────────────────────────

/** A suggested group as matching reads it. */
type GroupRead = { path: string; user: string; category: string; meta: AutoAlbumMeta; name?: string; memberIds: string[]; subject: Subject };

type GroupAttrs = { origin?: string; name?: string; autoAlbum?: AutoAlbumMeta; stagingMatches?: StagingMatches };

/** The groups at `paths` and their members, read in batched lookups; one that is not a suggested group, or cannot be read, is answered with why. */
const readGroups = async (
  vfs: Vfs,
  access: Access,
  paths: string[],
  locationIds: LocationIds,
): Promise<{ groups: GroupRead[]; skipped: { path: string; reason: string }[] }> => {
  const skipped: { path: string; reason: string }[] = [];
  const nodes = await nodesAt(vfs, access, paths);
  const valid: { path: string; node: Node }[] = [];
  for (const path of paths) {
    const node = nodes.get(path);
    const attrs = node?.attrs as GroupAttrs | undefined;
    if (!node || !isStagingGroup(path) || node.type !== 'album' || attrs?.origin !== AUTO_ORIGIN || !attrs.autoAlbum) skipped.push({ path, reason: 'not a suggested group' });
    else valid.push({ path, node });
  }
  if (valid.length === 0) return { groups: [], skipped };
  const listings = await vfs.childrenMany(access, valid.map((each) => each.path), { follow: false });
  const targets = new Map<string, string[]>();
  valid.forEach(({ path }, i) => {
    const listing = listings[i];
    targets.set(
      path,
      listing.status === 'fulfilled' ? listing.value.flatMap((entry) => entry.name !== COVER_LINK_NAME && entry.node.props.softlink ? [entry.node.props.softlink] : []) : [],
    );
  });
  const files = await nodesAt(vfs, access, [...new Set([...targets.values()].flat())]);
  const byId = new Map<string, { path: string; attrs: FileAttrs }>();
  for (const [path, node] of files) if (node.type === 'file') byId.set(node.id, { path, attrs: node.attrs as FileAttrs });
  const items = await readItems(vfs, access, byId, locationIds);
  const groups: GroupRead[] = [];
  for (const { path, node } of valid) {
    const attrs = node.attrs as GroupAttrs;
    const parsed = parseStagedPath(path)!;
    const memberIds = (targets.get(path) ?? []).flatMap((target) => files.get(target)?.id ?? []);
    const meta = attrs.autoAlbum!;
    const label = meta.seed?.label ?? (meta.kind === 'folder' ? attrs.name : undefined);
    groups.push({
      path,
      user: parsed.user,
      category: parsed.category!,
      meta,
      ...(attrs.name ? { name: attrs.name } : {}),
      memberIds,
      subject: {
        path,
        kind: 'group',
        ...(meta.kind ? { groupKind: meta.kind } : {}),
        ...(label ? { label } : {}),
        items: memberIds.flatMap((id) => items.get(id) ?? []),
      },
    });
  }
  return { groups, skipped };
};

/**
 * The rejections in `user`'s category `category` not undone: one query a page off the journal's
 * index. An entry counts only where `user`'s journal holds it.
 */
export const liveRejects = async (vfs: Vfs, access: Access, user: string, category: string): Promise<StagingReject[]> => {
  const { journalPath } = stagingRoots(user);
  const field = (name: string) => ({ path: ['stagingJournal', name] });
  const out: StagingReject[] = [];
  let after: { value: string | null; id: string } | undefined;
  while (true) {
    const rows = await vfs.query(access, {
      types: ['file'],
      where: [
        { ref: field('inbox'), op: 'eq', value: user },
        { ref: field('category'), op: 'eq', value: category },
        { ref: { path: [REJECT_ATTR, 'album'] }, op: 'exists' },
        { ref: field('undoneAt'), op: 'missing' },
      ],
      ...(after ? { after } : {}),
      limit: IDS_PER_CALL,
    });
    for (const row of rows) {
      if (dirname(row.absPath) !== journalPath) continue;
      const reject = row.node.attrs[REJECT_ATTR] as StagingReject | undefined;
      if (reject) out.push(reject);
    }
    if (rows.length < IDS_PER_CALL) return out;
    after = { value: rows[rows.length - 1].sortValue, id: rows[rows.length - 1].id };
  }
};

/** The kinds that are lanes; of them only a dated Everyday lane is matched, a day at a time. */
const LANES: readonly (GroupKind | undefined)[] = ['loose', 'clutter', 'undated'];

/** The matches of one group from its weighing. */
const matchesOf = (group: GroupRead, weighing: Weighing, writable: (albumId: string) => boolean, now: string): StagingMatches => {
  const { candidates, newAlbum } = rankCandidates(weighing.weighed, writable);
  const best = candidates[0];
  const verdict = best ? verdictOf(best.score, best.margin) : { proposal: 'new' as const, confidence: 'low' as MatchConfidence };
  return {
    computedAt: now,
    memberKey: group.meta.memberKey,
    model: MATCH_MODEL,
    proposal: verdict.proposal,
    confidence: verdict.confidence,
    newAlbum,
    visual: weighing.visual,
    candidates,
  };
};

/** Groups' paths in batches of at most `BATCH_MEMBERS` members, as their member counts say. */
const batchesOf = async (vfs: Vfs, access: Access, paths: string[]): Promise<string[][]> => {
  const nodes = await nodesAt(vfs, access, paths);
  const out: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const path of paths) {
    const members = Math.max(1, (nodes.get(path)?.attrs as GroupAttrs | undefined)?.autoAlbum?.memberCount ?? 1);
    if (size > 0 && size + members > BATCH_MEMBERS) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(path);
    size += members;
  }
  if (batch.length > 0) out.push(batch);
  return out;
};

/**
 * Match the suggested groups `paths` and write what is found on each as `stagingMatches`: an
 * event, trip, seed or scan run against the library; a dated Everyday lane a day at a time;
 * clutter, undated and period lanes not at all. Albums are judged by what each group's owner may
 * read and file into, and the owner's live rejections are honoured. Groups are read and written a
 * batch at a time.
 */
export const matchGroups = async (cmd: Command, paths: string[]): Promise<StagingMatchResult> => {
  const started = Date.now();
  const { vfs } = cmd.sys;
  const result: StagingMatchResult = { ok: true, matched: 0, skipped: [], durationMs: 0 };
  if (paths.length === 0) return result;
  const index = await profileIndex(vfs, cmd.access);
  const owners = new Map<string, Access>();
  const rejects = new Map<string, StagingReject[]>();
  const locationIds: LocationIds = new Map();

  for (const batch of await batchesOf(vfs, cmd.access, [...new Set(paths)])) {
    const { groups, skipped } = await readGroups(vfs, cmd.access, batch, locationIds);
    result.skipped.push(...skipped);
    const writes: { ref: string; attrs: Record<string, unknown> }[] = [];
    const now = new Date().toISOString();
    for (const group of groups) {
      if (!owners.has(group.user)) owners.set(group.user, await accessOfUser(vfs, cmd.access, group.user));
      const key = `${group.user}/${group.category}`;
      if (!rejects.has(key)) rejects.set(key, await liveRejects(vfs, cmd.access, group.user, group.category));
    }
    const contextOf = (group: GroupRead): MatchContext => ({ cmd, index, owner: owners.get(group.user)!, root: ALBUMS_ROOT });
    const refusedOf = (group: GroupRead) => rejectsFor(group.memberIds, rejects.get(`${group.user}/${group.category}`) ?? []);
    const writableIn = (group: GroupRead) => (albumId: string) => {
      const album = index.albums.get(albumId);
      return album !== undefined && verifyAccess(owners.get(group.user)!, album.props, 'w');
    };

    const weighed: GroupRead[] = [];
    for (const group of groups) {
      if (group.subject.items.length === 0) {
        result.skipped.push({ path: group.path, reason: 'no indexed members' });
        continue;
      }
      if (group.meta.kind === 'loose' && !group.meta.precision) {
        const days = matchDays(contextOf(group), group.subject.items, refusedOf(group));
        writes.push({
          ref: group.path,
          attrs: {
            [MATCHES_ATTR]: {
              computedAt: now,
              memberKey: group.meta.memberKey,
              model: MATCH_MODEL,
              proposal: 'new',
              confidence: 'low',
              newAlbum: 1,
              visual: false,
              candidates: [],
              days,
            } satisfies StagingMatches,
          },
        });
        continue;
      }
      if (LANES.includes(group.meta.kind)) {
        result.skipped.push({ path: group.path, reason: 'a lane, matched by its days or not at all' });
        continue;
      }
      weighed.push(group);
    }
    // One weighing per owner, so each sees the albums its owner may read.
    for (const user of new Set(weighed.map((group) => group.user))) {
      const mine = weighed.filter((group) => group.user === user);
      const weighings = await weighSubjects(contextOf(mine[0]), mine.map((group) => group.subject), (subject) => {
        const group = mine.find((each) => each.path === subject.path)!;
        return refusedOf(group);
      });
      for (const group of mine) writes.push({ ref: group.path, attrs: { [MATCHES_ATTR]: matchesOf(group, weighings.get(group.path)!, writableIn(group), now) } });
    }
    if (writes.length > 0) {
      const settled = await vfs.updateEach(cmd.access, writes);
      settled.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') result.matched++;
        else result.skipped.push({ path: String(writes[i].ref), reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
      });
    }
  }
  result.durationMs = Date.now() - started;
  return result;
};

/**
 * The suggested groups of `user`'s category `category` holding staged media taken within
 * `REMATCH_DAYS` of `days`: the media found by capture time within the category, a page at a
 * time, and their groups by the links to them.
 */
const groupsAround = async (cmd: Command, user: string, category: string, days: string[]): Promise<string[]> => {
  if (days.length === 0) return [];
  const { vfs } = cmd.sys;
  const albumsPath = categoryAlbumsPath(user, category);
  // A category without groups has none to find: one listing, not a query per window.
  const anyGroup = await vfs.children(cmd.access, albumsPath, { types: ['album'], page: { limit: 1 } }).catch(() => []);
  if (anyGroup.length === 0) return [];
  // Windows of whole days in UTC, a day wider each side so wall-clock days in any zone are inside.
  const sorted = [...new Set(days)].sort();
  const windows: [string, string][] = [];
  for (const day of sorted) {
    const from = addDays(day, -REMATCH_DAYS - 1);
    const to = addDays(day, REMATCH_DAYS + 2);
    const last = windows[windows.length - 1];
    if (last && from <= last[1]) last[1] = to > last[1] ? to : last[1];
    else windows.push([from, to]);
  }
  const files: string[] = [];
  for (const [from, to] of windows) {
    let after: { value: string | null; id: string } | undefined;
    while (files.length < AROUND_MAX) {
      const rows = await vfs.query(cmd.access, {
        within: categoryPath(user, category),
        types: ['file'],
        where: [{ ref: 'takenAtUtc', op: 'gte', value: `${from}T00:00:00Z` }, { ref: 'takenAtUtc', op: 'lt', value: `${to}T00:00:00Z` }],
        ...(after ? { after } : {}),
        limit: AROUND_PAGE,
      });
      files.push(...rows.map((row) => row.absPath));
      if (rows.length < AROUND_PAGE) break;
      after = { value: rows[rows.length - 1].sortValue, id: rows[rows.length - 1].id };
    }
  }
  const groups = new Set<string>();
  for (const batch of chunks(files, 2000)) {
    for (const link of await vfs.findLinks(cmd.access, batch, Number.MAX_SAFE_INTEGER)) {
      const group = dirname(link.absPath);
      if (dirname(group) === albumsPath) groups.add(group);
    }
  }
  return [...groups];
};

/** Match again the groups of `user`'s category `category` around `days`, the days a library album's profile just changed on. */
export const rematchAround = async (cmd: Command, user: string, category: string, days: string[]): Promise<StagingMatchResult> =>
  await matchGroups(cmd, await groupsAround(cmd, user, category, days));

/**
 * The groups of `user`'s category `category` around the days of every library album whose profile
 * was computed after `since`: what filing into an album changes for the groups near its days, so
 * a trip's second day comes to offer the album its first day went into.
 */
export const groupsChangedSince = async (cmd: Command, user: string, category: string, since: string): Promise<string[]> => {
  const index = await profileIndex(cmd.sys.vfs, cmd.access);
  const days = [...index.albums.values()].filter((album) => album.profile.computedAt > since).flatMap((album) => album.profile.changedDays);
  return await groupsAround(cmd, user, category, days);
};

/**
 * Whether a group is due a match: it is one matching weighs (not clutter, an undated lane or a
 * period lane), and it has no matches for its members as they are now, or matches another model
 * made, or one of its candidates has a profile newer than its matches, or none any more (the album
 * is gone).
 */
export const matchDue = (attrs: GroupAttrs, index: ProfileIndex): boolean => {
  const meta = attrs.autoAlbum;
  if (!meta || meta.kind === 'clutter' || meta.kind === 'undated' || (meta.kind === 'loose' && meta.precision)) return false;
  const matches = attrs.stagingMatches;
  if (!matches || matches.memberKey !== meta.memberKey || matches.model !== MATCH_MODEL) return true;
  return matches.candidates.some((candidate) => {
    const album = index.albums.get(candidate.albumId);
    return !album || album.profile.computedAt > matches.computedAt;
  });
};

/**
 * Stored matches without the album `albumId`: its candidacy and its days gone, and the choice
 * among what is left, the rest in order with their probabilities shared out again, their margins
 * and the verdict taken again. What a rejection does to the group it is made on at once, with
 * nothing read again.
 */
export const withoutAlbum = (matches: StagingMatches, albumId: string): StagingMatches => {
  const gone = matches.candidates.find((candidate) => candidate.albumId === albumId)?.score ?? 0;
  const share = (score: number) => gone < 1 ? round3(score / (1 - gone)) : score;
  const kept = matches.candidates.filter((candidate) => candidate.albumId !== albumId).map((candidate) => ({ ...candidate, score: share(candidate.score) }));
  const candidates = withMargins(kept);
  const best = candidates[0];
  const verdict = best ? verdictOf(best.score, best.margin) : { proposal: 'new' as const, confidence: 'low' as MatchConfidence };
  return {
    ...matches,
    proposal: verdict.proposal,
    confidence: verdict.confidence,
    newAlbum: Math.min(1, share(matches.newAlbum)),
    candidates,
    ...(matches.days ? { days: matches.days.filter((day) => day.albumId !== albumId) } : {}),
  };
};

/**
 * What a promote's journal entry keeps of the group it filed (`stagingMatchDecision`): the
 * matches it had when the person chose, while they were for its members as they were, and what
 * was chosen — the album's id, or `new`.
 */
export const matchDecisionOf = (attrs: GroupAttrs, chosen: string): StagingMatchDecision | undefined => {
  const matches = attrs.stagingMatches;
  if (!matches || matches.memberKey !== attrs.autoAlbum?.memberKey) return undefined;
  return {
    computedAt: matches.computedAt,
    model: matches.model,
    chosen,
    candidates: matches.candidates.map((candidate, rank) => ({ albumId: candidate.albumId, score: candidate.score, rank: rank + 1, evidence: candidate.evidence })),
  };
};
