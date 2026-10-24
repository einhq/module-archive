/**
 * Album profiles: what staging matches suggested groups against, one per library album, kept
 * beside it as its `.profile` child (an `album-profile` node holding `attrs.albumProfile`).
 *
 * A profile summarises the album's members (`albumMembers`' rules: the album's own media, or its
 * `files/` directory's, and the files it links): their capture instants and days, where they were
 * taken (0.01° cells and linked locations), who is in them, and up to four member picture vectors
 * that stand for how the album looks — the members nearest the centres of a short k-means over at
 * most 200 of their vectors, kept by embedding node id, never as copied vectors.
 *
 * Profiles are built a batch of albums at a time (`profileAlbums`): their listings in one read,
 * linked members, signals, locations and picture-vector ids in batched lookups by id, and the
 * vectors themselves only for the albums whose members changed. A build whose `signature` (the
 * members, their times, whether each has a position, a vector, its people and location) equals the
 * stored one writes nothing but, when asked to check stale profiles, the time it was checked.
 */
import { resolve } from '@std/path';
import type { Command, Node, NodeChildEntry } from '@ein/client';
import { isOriginalMedia } from '@ein/client';
import type { AlbumProfile } from '@archive/media/api';
import { PICTURE_DIR } from '@archive/media/embedding-types';
import { NON_MEMBER_LINK_NAMES } from '@archive/media/types';
import { AUTO_ORIGIN } from '@archive/staging/auto-album';
import { idsAt, nodesAt } from '@archive/staging/nodes-at';
import { readSignals } from '@archive/staging/signals';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The profile's name under its album, its node type and the attr that holds it. */
export const PROFILE_NAME = '.profile';
export const PROFILE_TYPE = 'album-profile';
export const PROFILE_ATTR = 'albumProfile';

/** What a profile is built by: part of every signature, so a change to the build makes every profile stale. */
const RECIPE = 1;

const TIMES_MAX = 1024;
const DAYS_MAX = 400;
const CHANGED_MAX = 64;
const CELLS_MAX = 64;
const LOCATIONS_MAX = 16;
const PEOPLE_MAX = 48;
const PROTOTYPES_MAX = 4;
/** One prototype per this many members with a vector, up to `PROTOTYPES_MAX`. */
const MEMBERS_PER_PROTOTYPE = 50;
/**
 * Vectors one album's prototypes are found among at most: plenty for four centres, and what bounds
 * a backfill's reads, since every vector comes back as a thousand numbers in text.
 */
const PROTOTYPE_SAMPLE = 200;
const KMEANS_ROUNDS = 5;
/** A cell's side, in degrees. */
const CELL_DEGREES = 0.01;
/** Ids per batched lookup. */
const IDS_PER_CALL = 1000;
/** Members one batch of albums holds at most, as their `mediaCount` says; an album larger than this is a batch of its own. */
const BATCH_MEMBERS = 2000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FILES_DIR = 'files';
const NODE_TYPE_ALBUM = 'album';

const chunks = <T>(items: T[], size = IDS_PER_CALL): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** A member as a profile reads it. */
type ProfileMember = {
  id: string;
  takenAt?: string;
  takenAtUtc?: string;
  point?: { lat: number; lng: number };
  persons: string[];
  /** The id of the location it is linked to. */
  location?: string;
  /** Its picture vector's embedding node id. */
  vector?: string;
};

/** A wall clock's day, `YYYY-MM-DD`, when it is known to the day. */
export const dayOfWall = (takenAt: string | undefined): string | undefined =>
  typeof takenAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(takenAt) ? takenAt.slice(0, 10) : undefined;

/** An instant as epoch minutes, when it is one. */
export const minuteOf = (iso: string | undefined): number | undefined => {
  if (typeof iso !== 'string') return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / MINUTE_MS) : undefined;
};

/** The 0.01° cell a point lies in, `latIndex:lngIndex`. */
export const cellOf = (point: { lat: number; lng: number }): string => `${Math.floor(point.lat / CELL_DEGREES)}:${Math.floor(point.lng / CELL_DEGREES)}`;

/** The cell and its eight neighbours. */
export const cellAndNeighbours = (cell: string): string[] => {
  const [lat, lng] = cell.split(':').map(Number);
  const out: string[] = [];
  for (let dLat = -1; dLat <= 1; dLat++) for (let dLng = -1; dLng <= 1; dLng++) out.push(`${lat + dLat}:${lng + dLng}`);
  return out;
};

/** A 32-bit FNV-1a hash of a string: a seed, and a stable order. */
const hash32 = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** A small seeded random source (mulberry32), so a profile's prototypes are the same every build. */
const seeded = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** At most `max` of `ids`, the same ones every time for the same `seed`. */
export const sampleIds = (ids: string[], max: number, seed: string): string[] =>
  ids.length <= max
    ? ids
    : ids.map((id) => ({ id, key: hash32(`${seed}:${id}`) })).sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : 1)).slice(0, max).map((each) => each.id);

const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

const normalized = (values: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(values);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) { for (let i = 0; i < out.length; i++) out[i] /= norm; }
  return out;
};

/**
 * The members that stand for `vectors` (unit vectors by id): k-means++ seeded by `seed`, a few
 * rounds of k-means on cosine, then for each centre the member nearest it. At most `k` ids, each
 * once, in no particular order.
 */
export const representativesOf = (vectors: { id: string; vector: Float32Array }[], k: number, seed: string): string[] => {
  const n = vectors.length;
  if (n === 0 || k <= 0) return [];
  if (n <= k) return vectors.map((each) => each.id);
  const random = seeded(hash32(seed));
  const centres: Float32Array[] = [vectors[Math.floor(random() * n)].vector.slice()];
  const nearest = new Float64Array(n).fill(Infinity);
  while (centres.length < k) {
    const last = centres[centres.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      nearest[i] = Math.min(nearest[i], Math.max(0, 1 - dot(vectors[i].vector, last)));
      total += nearest[i];
    }
    if (total <= 0) break;
    let pick = random() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      pick -= nearest[i];
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    centres.push(vectors[chosen].vector.slice());
  }
  const dimension = vectors[0].vector.length;
  const owner = new Int32Array(n);
  for (let round = 0; round < KMEANS_ROUNDS; round++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSimilarity = -Infinity;
      centres.forEach((centre, c) => {
        const similarity = dot(vectors[i].vector, centre);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          best = c;
        }
      });
      owner[i] = best;
    }
    for (let c = 0; c < centres.length; c++) {
      const sum = new Float64Array(dimension);
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (owner[i] !== c) continue;
        count++;
        const vector = vectors[i].vector;
        for (let d = 0; d < dimension; d++) sum[d] += vector[d];
      }
      if (count > 0) centres[c] = normalized(sum);
    }
  }
  const ids = new Set<string>();
  for (const centre of centres) {
    let best = vectors[0];
    let bestSimilarity = -Infinity;
    for (const each of vectors) {
      const similarity = dot(each.vector, centre);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = each;
      }
    }
    ids.add(best.id);
  }
  return [...ids];
};

/** The `max` entries of `counts` with the most, ties by key, most first. */
const top = (counts: Map<string, number>, max: number): [string, number][] =>
  [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, max);

const count = (counts: Map<string, number>, key: string | undefined): void => {
  if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** `max` of `values`, spread evenly over them in order. */
const spread = <T>(values: T[], max: number): T[] => {
  if (values.length <= max) return values;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.floor((i * values.length) / max)]);
  return out;
};

/**
 * The capture instants a profile keeps: every one while there are at most `TIMES_MAX`; otherwise
 * the first of each day (spread over them when even those are too many), then the rest spread
 * evenly, sorted.
 */
const keptTimes = (dated: { minute: number; day: string }[]): number[] => {
  const minutes = [...new Set(dated.map((each) => each.minute))].sort((a, b) => a - b);
  if (minutes.length <= TIMES_MAX) return minutes;
  const firstOfDay = new Map<string, number>();
  for (const each of [...dated].sort((a, b) => a.minute - b.minute)) if (!firstOfDay.has(each.day)) firstOfDay.set(each.day, each.minute);
  const firsts = spread([...new Set(firstOfDay.values())].sort((a, b) => a - b), TIMES_MAX);
  const chosen = new Set(firsts);
  const rest = minutes.filter((minute) => !chosen.has(minute));
  for (const minute of spread(rest, TIMES_MAX - chosen.size)) chosen.add(minute);
  return [...chosen].sort((a, b) => a - b);
};

/** A hex digest of `text`. */
const digest = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** The signature of what a profile is built from: the recipe, and each member's id, times, position, vector, people and location. */
const signatureOf = (members: ProfileMember[]): Promise<string> =>
  digest(
    [
      `recipe ${RECIPE}`,
      ...members.map((member) =>
        [member.id, member.takenAtUtc ?? '', member.takenAt ?? '', member.point ? 1 : 0, member.vector ? 1 : 0, member.persons.toSorted().join(','), member.location ?? '']
          .join('|')
      ).sort(),
    ].join('\n'),
  );

/** The prototypes an album of `withVectors` members with a vector has. */
const prototypeCount = (withVectors: number): number => Math.min(PROTOTYPES_MAX, Math.ceil(withVectors / MEMBERS_PER_PROTOTYPE));

/**
 * The profile of `members`, given the unit vectors of some of them (a sample, by embedding id) in
 * `pictureType`, and the profile before (whose day counts `changedDays` is the difference from).
 */
const buildProfile = (
  input: {
    albumId: string;
    members: ProfileMember[];
    signature: string;
    vectors: Map<string, Float32Array>;
    pictureType?: string;
    previous?: AlbumProfile;
    now: string;
  },
): AlbumProfile => {
  const { members } = input;
  const dated: { minute: number; day: string }[] = [];
  let datedCount = 0;
  const days = new Map<string, number>();
  const cells = new Map<string, number>();
  const locations = new Map<string, number>();
  const people = new Map<string, number>();
  for (const member of members) {
    const minute = minuteOf(member.takenAtUtc);
    if (minute !== undefined) {
      datedCount++;
      const day = dayOfWall(member.takenAt);
      if (day) {
        dated.push({ minute, day });
        count(days, day);
      }
    }
    if (member.point) count(cells, cellOf(member.point));
    count(locations, member.location);
    for (const person of new Set(member.persons)) count(people, person);
  }
  const dayKeys = [...days.keys()].sort();
  const spanDays = dayKeys.length === 0 ? 0 : Math.round((Date.parse(dayKeys[dayKeys.length - 1]) - Date.parse(dayKeys[0])) / DAY_MS) + 1;
  const before = new Map(input.previous?.days ?? []);
  const changedDays = [...new Set([...days.keys(), ...before.keys()])].filter((day) => days.get(day) !== before.get(day)).sort().slice(0, CHANGED_MAX);

  const withVectors = members.flatMap((member) => {
    const vector = member.vector ? input.vectors.get(member.vector) : undefined;
    return vector ? [{ id: member.vector!, vector }] : [];
  });
  const prototypes = representativesOf(withVectors, prototypeCount(withVectors.length), input.albumId);
  return {
    version: 1,
    signature: input.signature,
    computedAt: input.now,
    checkedAt: input.now,
    ...(prototypes.length > 0 && input.pictureType ? { pictureType: input.pictureType } : {}),
    members: members.length,
    dated: datedCount,
    activeDays: days.size,
    spanDays,
    times: keptTimes(dated),
    days: top(days, DAYS_MAX).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    changedDays,
    cells: top(cells, CELLS_MAX),
    locations: top(locations, LOCATIONS_MAX),
    people: top(people, PEOPLE_MAX),
    prototypes: input.pictureType ? prototypes : [],
  };
};

// ── reading ─────────────────────────────────────────────────────────────────

/**
 * Each file's picture vector, by file id: its `metadata/picture/embedding`, or a video's first
 * keyframe `k0`. Three rounds of batched child lookups; a file with none is absent.
 */
export const pictureVectorIds = async (vfs: Vfs, access: Access, fileIds: string[]): Promise<Map<string, string>> => {
  const step = async (parents: Map<string, string>, pick: (children: { name: string; id: string }[]) => string | undefined): Promise<Map<string, string>> => {
    const next = new Map<string, string>();
    for (const batch of chunks([...parents.keys()])) {
      for (const [id, children] of await vfs.getChildLinksByIds(access, batch)) {
        const child = pick(children);
        if (child) next.set(child, parents.get(id)!);
      }
    }
    return next;
  };
  const named = (name: string) => (children: { name: string; id: string }[]) => children.find((child) => child.name === name)?.id;
  const metadata = await step(new Map(fileIds.map((id) => [id, id])), named('metadata'));
  const pictures = await step(metadata, named(PICTURE_DIR));
  const vectors = await step(pictures, (children) => (children.find((child) => child.name === 'embedding') ?? children.find((child) => child.name === 'k0'))?.id);
  return new Map([...vectors].map(([vectorId, fileId]) => [fileId, vectorId]));
};

/**
 * The vectors behind embedding ids, unit length, with the embedding type each is in. Ids without
 * one are absent.
 */
export const readUnitVectors = async (vfs: Vfs, access: Access, ids: string[]): Promise<Map<string, { type: string; vector: Float32Array }>> => {
  const byType = new Map<string, string[]>();
  for (const batch of chunks(ids)) {
    for (const [id, node] of await vfs.getNodesByIds(access, batch)) {
      const type = node.attrs.embeddingType;
      if (typeof type === 'string') byType.set(type, [...byType.get(type) ?? [], id]);
    }
  }
  const out = new Map<string, { type: string; vector: Float32Array }>();
  const decoder = new TextDecoder();
  for (const [type, typed] of byType) {
    for (const batch of chunks(typed)) {
      for (const [id, bytes] of await vfs.getVectors(access, type, batch)) {
        try {
          out.set(id, { type, vector: normalized(JSON.parse(decoder.decode(bytes)) as number[]) });
        } catch {
          // A vector that is not stored as JSON numbers stands for nothing here.
        }
      }
    }
  }
  return out;
};

/** The most common of `values`; undefined for none. */
export const majority = (values: string[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const value of values) count(counts, value);
  return top(counts, 1)[0]?.[0];
};

/** A library album as a build takes it. */
export type ProfiledAlbum = { path: string; id: string; props: { uid: number; gid: number; mode: number }; mediaCount?: number };

/** One album's members as a build read them, and its profile as it was. */
type Listed = { album: ProfiledAlbum; members: Node[]; previous?: { path: string; profile: AlbumProfile } } | { album: ProfiledAlbum; error: string };

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The members of each of `albums` by `albumMembers`' rules, and each one's stored profile: their
 * listings in one read, the `files/` directories of those that keep their media there in a
 * second, and the files they link in one more (`nodesAt`). An album that cannot be listed is
 * answered with why.
 */
const listAlbums = async (vfs: Vfs, access: Access, albums: ProfiledAlbum[]): Promise<Listed[]> => {
  const first = await vfs.childrenMany(access, albums.map((album) => album.path), { follow: false });
  const listings: { album: ProfiledAlbum; entries: NodeChildEntry[]; container: string; previous?: { path: string; profile: AlbumProfile } }[] = [];
  const out: Listed[] = [];
  const intoFiles: number[] = [];
  albums.forEach((album, index) => {
    const settled = first[index];
    if (settled.status === 'rejected') {
      out.push({ album, error: messageOf(settled.reason) });
      return;
    }
    const entries = settled.value;
    const stored = entries.find((entry) => entry.name === PROFILE_NAME && entry.node.type === PROFILE_TYPE);
    const profile = stored?.node.attrs[PROFILE_ATTR] as AlbumProfile | undefined;
    const holdsMedia = entries.some((entry) => isOriginalMedia(entry.node) || (entry.node.props.softlink && !NON_MEMBER_LINK_NAMES.includes(entry.name)));
    const filesDir = !holdsMedia && entries.some((entry) => entry.name === FILES_DIR && entry.node.type === 'directory');
    listings.push({ album, entries, container: album.path, ...(profile ? { previous: { path: `${album.path}/${PROFILE_NAME}`, profile } } : {}) });
    if (filesDir) intoFiles.push(listings.length - 1);
  });
  if (intoFiles.length > 0) {
    const second = await vfs.childrenMany(access, intoFiles.map((at) => `${listings[at].album.path}/${FILES_DIR}`), { follow: false });
    intoFiles.forEach((at, i) => {
      const settled = second[i];
      listings[at].container = `${listings[at].album.path}/${FILES_DIR}`;
      listings[at].entries = settled.status === 'fulfilled' ? settled.value : [];
    });
  }
  const targets = listings.flatMap((listing) =>
    listing.entries.flatMap((entry) => entry.node.props.softlink && !NON_MEMBER_LINK_NAMES.includes(entry.name) ? [resolve(listing.container, entry.node.props.softlink)] : [])
  );
  const linked = targets.length > 0 ? await nodesAt(vfs, access, [...new Set(targets)]) : new Map<string, Node>();
  for (const listing of listings) {
    const members = new Map<string, Node>();
    for (const entry of listing.entries) {
      if (entry.node.props.softlink) {
        if (NON_MEMBER_LINK_NAMES.includes(entry.name)) continue;
        const node = linked.get(resolve(listing.container, entry.node.props.softlink));
        if (node && isOriginalMedia(node)) members.set(node.id, node);
      } else if (isOriginalMedia(entry.node)) members.set(entry.node.id, entry.node);
    }
    out.push({ album: listing.album, members: [...members.values()], ...(listing.previous ? { previous: listing.previous } : {}) });
  }
  return out;
};

/** How a batch of profiles came out: each album's new profile (in memory when not written) and what was done with it. */
type ProfileOutcome = {
  album: ProfiledAlbum;
  status: 'written' | 'unchanged' | 'failed';
  profile?: AlbumProfile;
  error?: string;
};

type BuildOptions = {
  /** Rebuild even when the signature is unchanged. */
  force?: boolean;
  /** Write the profiles; otherwise build them in memory only. */
  write?: boolean;
  /** Leave these files (by id) out of every album, as if they were not members. */
  exclude?: ReadonlySet<string>;
};

/** The location ids of location paths read so far, kept across batches of one run. */
type LocationIds = Map<string, string | undefined>;

/** One batch of albums: read, signed, and built (and written) where their signature changed. */
const profileBatch = async (cmd: Command, albums: ProfiledAlbum[], options: BuildOptions, locationIds: LocationIds): Promise<ProfileOutcome[]> => {
  const { vfs } = cmd.sys;
  const access = cmd.access;
  const listed = await listAlbums(vfs, access, albums);
  const outcomes: ProfileOutcome[] = [];
  const read = listed.flatMap((each) => 'error' in each ? [] : [each]);
  for (const each of listed) if ('error' in each) outcomes.push({ album: each.album, status: 'failed', error: each.error });

  for (const each of read) if (options.exclude) each.members = each.members.filter((member) => !options.exclude!.has(member.id));
  const memberIds = [...new Set(read.flatMap((each) => each.members.map((member) => member.id)))];
  const signals = await readSignals(vfs, access, memberIds);
  const vectorIds = await pictureVectorIds(vfs, access, memberIds);
  const unresolved = [...new Set([...signals.values()].flatMap((signal) => signal.location ?? []))].filter((path) => !locationIds.has(path));
  if (unresolved.length > 0) {
    const found = await idsAt(vfs, access, unresolved);
    for (const path of unresolved) locationIds.set(path, found.get(path));
  }

  const now = new Date().toISOString();
  const building: { album: ProfiledAlbum; members: ProfileMember[]; signature: string; previous?: { path: string; profile: AlbumProfile } }[] = [];
  for (const each of read) {
    const members = each.members.map((node): ProfileMember => {
      const signal = signals.get(node.id);
      const location = signal?.location ? locationIds.get(signal.location) : undefined;
      const vector = vectorIds.get(node.id);
      return {
        id: node.id,
        ...(typeof node.attrs.takenAt === 'string' ? { takenAt: node.attrs.takenAt } : {}),
        ...(typeof node.attrs.takenAtUtc === 'string' ? { takenAtUtc: node.attrs.takenAtUtc } : {}),
        ...(signal?.point ? { point: signal.point } : {}),
        persons: signal?.persons ?? [],
        ...(location ? { location } : {}),
        ...(vector ? { vector } : {}),
      };
    });
    const signature = await signatureOf(members);
    if (!options.force && each.previous?.profile.signature === signature && each.previous.profile.version === 1) {
      outcomes.push({ album: each.album, status: 'unchanged', profile: each.previous.profile });
      continue;
    }
    building.push({ album: each.album, members, signature, ...(each.previous ? { previous: each.previous } : {}) });
  }

  // The vectors only of the albums being built, a sample of each.
  const samples = new Map(building.map((each) => [each.album.path, sampleIds(each.members.flatMap((member) => member.vector ?? []), PROTOTYPE_SAMPLE, each.album.id)]));
  const vectors = await readUnitVectors(vfs, access, [...new Set([...samples.values()].flat())]);

  const writes: { ref: string; attrs: Record<string, unknown> }[] = [];
  const creates: ProfileOutcome[] = [];
  for (const each of building) {
    const sample = (samples.get(each.album.path) ?? []).flatMap((id) => vectors.get(id) ? [{ id, ...vectors.get(id)! }] : []);
    const pictureType = majority(sample.map((entry) => entry.type));
    const profile = buildProfile({
      albumId: each.album.id,
      members: each.members,
      signature: each.signature,
      vectors: new Map(sample.filter((entry) => entry.type === pictureType).map((entry) => [entry.id, entry.vector])),
      ...(pictureType ? { pictureType } : {}),
      ...(each.previous ? { previous: each.previous.profile } : {}),
      now,
    });
    const outcome: ProfileOutcome = { album: each.album, status: 'written', profile };
    if (!options.write) outcomes.push(outcome);
    else if (each.previous) {
      writes.push({ ref: each.previous.path, attrs: { [PROFILE_ATTR]: profile } });
      outcomes.push(outcome);
    } else creates.push(outcome);
  }
  if (writes.length > 0) {
    const settled = await vfs.updateEach(access, writes);
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') return;
      const outcome = outcomes.find((each) => each.profile === writes[i].attrs[PROFILE_ATTR]);
      if (outcome) Object.assign(outcome, { status: 'failed', error: messageOf(result.reason) });
    });
  }
  for (const outcome of creates) {
    const { album } = outcome;
    try {
      await vfs.create(access, PROFILE_TYPE, album.path, PROFILE_NAME, {
        props: { uid: album.props.uid, gid: album.props.gid, mode: album.props.mode & 0o666 },
        attrs: { [PROFILE_ATTR]: outcome.profile },
      });
      outcomes.push(outcome);
    } catch (error) {
      outcomes.push({ album, status: 'failed', error: messageOf(error) });
    }
  }
  return outcomes;
};

/**
 * Build the profiles of `albums`, a batch of at most `BATCH_MEMBERS` members (by their
 * `mediaCount`) at a time, writing those whose members changed unless `write` is false. Answers
 * each album's outcome, in no particular order.
 */
export const profileAlbums = async (cmd: Command, albums: ProfiledAlbum[], options: BuildOptions = {}): Promise<ProfileOutcome[]> => {
  const outcomes: ProfileOutcome[] = [];
  const locationIds: LocationIds = new Map();
  let batch: ProfiledAlbum[] = [];
  let size = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    try {
      outcomes.push(...await profileBatch(cmd, batch, options, locationIds));
    } catch (error) {
      outcomes.push(...batch.map((album): ProfileOutcome => ({ album, status: 'failed', error: messageOf(error) })));
    }
    batch = [];
    size = 0;
  };
  for (const album of albums) {
    const members = Math.max(1, album.mediaCount ?? 200);
    if (size > 0 && size + members > BATCH_MEMBERS) await flush();
    batch.push(album);
    size += members;
  }
  await flush();
  return outcomes;
};

/** Mark `profiles` (their paths) checked now, without building them again. */
export const markChecked = async (vfs: Vfs, access: Access, profiles: { path: string; profile: AlbumProfile }[]): Promise<void> => {
  if (profiles.length === 0) return;
  const now = new Date().toISOString();
  await vfs.updateEach(access, profiles.map(({ path, profile }) => ({ ref: path, attrs: { [PROFILE_ATTR]: { ...profile, checkedAt: now } } })));
};

/** Whether `node` at `path` is a library album a profile is kept for: an album within `root` that staging did not suggest. */
export const isProfiled = (node: { type: string; attrs: Record<string, unknown> }, path: string, root: string): boolean =>
  node.type === NODE_TYPE_ALBUM && node.attrs.origin !== AUTO_ORIGIN && path.startsWith(`${root}/`);
