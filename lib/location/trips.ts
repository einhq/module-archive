/**
 * Trips and stays, derived from a camera's track (`@archive/location/trips`).
 *
 * The track is first collapsed into clusters: a cluster grows while the camera stays within the
 * cluster radius of where the cluster began. Then:
 *
 * - A cluster at one of the camera's homes, held for half an hour or more, is a `home` stay; one
 *   held longer than the long rest anywhere else is a `rest` stay. Either ends the trip arriving
 *   there and starts the next one there. So does a gap without fixes longer than the long rest,
 *   where the camera was last seen.
 * - A cluster held for two hours or more across a local midnight is an `overnight` stay: it is
 *   kept, but the trip goes on.
 * - A trip is cut into one leg per local day, in the camera's timezone. Each leg ends where the
 *   camera was at the day's last fix: on the stay it spent the night at, or at that fix. A leg's
 *   length runs from the day before's last fix, so the legs add up to the whole trip.
 * - The destination is the farthest stay from the start, or the farthest fix when the trip
 *   stayed nowhere 500 m or more from it. A trip that never gets 500 m from its start is dropped.
 * - A trip that has not ended at a stay or a gap is ongoing while its last fix is under 48 h old.
 *
 * `TripEdits` change the cut: a merge joins a trip to the one before it, whatever ended that one;
 * a split starts a trip at a local midnight.
 *
 * Imports only types, so it runs anywhere and is tested on invented tracks.
 */

import type { Trip, TripEdits, TripPlace, TripStay } from '@archive/location/api';

/** A fix: epoch ms, and where. Fixes go in sorted by `ms`. */
export type TripFix = { ms: number; lat: number; lng: number };

/**
 * One of the camera's homes: where it is, and the location it is. `from` and `to` (`YYYY`,
 * `YYYY-MM` or `YYYY-MM-DD`, either open) bound the local days it is a home on.
 */
export type TripHome = { lat: number; lng: number; path: string; from?: string; to?: string };

/** Whether a home is one on local day `day`, its span compared to the same precision. */
const homeOn = (home: TripHome, day: string): boolean => (!home.from || day.slice(0, home.from.length) >= home.from) && (!home.to || day.slice(0, home.to.length) <= home.to);

export type TripSettings = {
  /** Fixes within this many metres of a cluster's first are one place; also how near a home is home. */
  clusterRadiusM: number;
  /** A stay, or a gap without fixes, longer than this ends a trip. */
  longRestMs: number;
  /** IANA id the legs' days are cut in; UTC when absent. */
  timezone?: string;
  homes?: TripHome[];
  edits?: TripEdits;
  /** The time `ongoing` is judged at, epoch ms. */
  now?: number;
};

/** What `segmentTrips` derives. Trips carry no candidate albums yet; stays are in time order. */
export type TripSegmentation = {
  trips: Omit<Trip, 'albums'>[];
  stays: TripStay[];
  /**
   * Epoch ms from which reading the track again reproduces everything after it: the start of the
   * last stay or gap that ended a trip for good. Trips that end before it and stays that start
   * before it do not change while fixes are only appended.
   */
  settledUntil?: number;
};

/** A stay across a local midnight at least this long is an overnight stay. */
const OVERNIGHT_MIN_MS = 2 * 60 * 60 * 1000;
/** A home ends a trip once the camera has been there this long, or when its track ends there. */
const HOME_MIN_MS = 30 * 60 * 1000;
/** A trip that never gets this many metres from its start is not one. */
const MIN_TRIP_M = 500;
/** A trip that has not ended is ongoing while its last fix is younger than this. */
const ONGOING_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Great-circle distance in metres. */
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const s1 = Math.sin(((bLat - aLat) * toRad) / 2);
  const s2 = Math.sin(((bLng - aLng) * toRad) / 2);
  const a = s1 * s1 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Every UTC offset in use is a whole number of quarter hours, so a local day changes only on one. */
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/** `ms` → its `YYYY-MM-DD` in `timezone`, formatting once per quarter hour. */
export function localDayOf(timezone = 'UTC'): (ms: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  let bucket = NaN;
  let day = '';
  return (ms) => {
    const at = Math.floor(ms / QUARTER_HOUR_MS);
    if (at !== bucket) {
      bucket = at;
      day = format.format(at * QUARTER_HOUR_MS);
    }
    return day;
  };
}

type Cluster = {
  /** The first fix's position, which later fixes are measured against. */
  lat: number;
  lng: number;
  startMs: number;
  endMs: number;
  points: TripFix[];
};

/** The mean of a cluster's fixes: for a long stay, the berth rather than a fix at the edge. */
function centroid(c: Cluster): { lat: number; lng: number } {
  let lat = 0, lng = 0;
  for (const p of c.points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / c.points.length, lng: lng / c.points.length };
}

/** Consecutive fixes within `radius` metres of where their run began, as clusters. */
function clusterFixes(fixes: TripFix[], radius: number): Cluster[] {
  const clusters: Cluster[] = [];
  let cur: Cluster | null = null;
  for (const p of fixes) {
    if (!cur || haversine(cur.lat, cur.lng, p.lat, p.lng) > radius) {
      cur = { lat: p.lat, lng: p.lng, startMs: p.ms, endMs: p.ms, points: [p] };
      clusters.push(cur);
    } else {
      cur.endMs = p.ms;
      cur.points.push(p);
    }
  }
  return clusters;
}

/** A fix, with its local day and the place its cluster stands for. */
type Tagged = { fix: TripFix; day: string; lat: number; lng: number; stay?: number };

/** Where a stream starts or ends: at a stay, or at a fix; `open` where the track itself ends, so the trip may go on. */
type End = { lat: number; lng: number; ms: number; stay?: number; open?: boolean };

/** One trip's worth of fixes before merging and dropping. */
type Stream = { start: End; end: End; pts: Tagged[]; settle?: number; joined: string[] };

const iso = (ms: number): string => new Date(ms).toISOString();

const place = (end: End): TripPlace => ({
  lat: end.lat,
  lng: end.lng,
  time: iso(end.ms),
  ...(end.stay !== undefined ? { stay: end.stay } : {}),
});

const taggedEnd = (t: Tagged): End => ({ lat: t.lat, lng: t.lng, ms: t.fix.ms, ...(t.stay !== undefined ? { stay: t.stay } : {}) });

function boundsOf(pts: TripFix[]): Trip['bounds'] {
  let north = pts[0].lat, south = pts[0].lat, east = pts[0].lng, west = pts[0].lng;
  for (const p of pts) {
    if (p.lat > north) north = p.lat;
    if (p.lat < south) south = p.lat;
    if (p.lng > east) east = p.lng;
    if (p.lng < west) west = p.lng;
  }
  return { north, south, east, west };
}

function lengthOf(pts: TripFix[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  return Math.round(d);
}

/** Split ms-sorted fixes into trips and stays (see the file comment). */
export function segmentTrips(fixes: TripFix[], settings: TripSettings): TripSegmentation {
  const { clusterRadiusM, longRestMs, homes = [], edits = {}, now = Date.now() } = settings;
  const dayOf = localDayOf(settings.timezone);
  const merges = new Set(edits.merge ?? []);
  const splits = new Set(edits.split ?? []);
  const stays: TripStay[] = [];
  if (fixes.length === 0) return { trips: [], stays };

  const homeAt = (lat: number, lng: number, day: string): TripHome | undefined => {
    let best: TripHome | undefined;
    let bestDist = Infinity;
    for (const home of homes) {
      if (!homeOn(home, day)) continue;
      const d = haversine(home.lat, home.lng, lat, lng);
      if (d <= clusterRadiusM && d < bestDist) {
        best = home;
        bestDist = d;
      }
    }
    return best;
  };

  // --- Cut the track into streams at homes, long rests, gaps and splits ---

  const streams: Stream[] = [];
  let cur: Tagged[] = [];
  let start: End | null = null;
  /** Where reading again reproduces the open stream: its starting stay or the fix after its gap. */
  let settle: number | undefined;
  /** The settle point of a stay or gap with no stream after it yet. */
  let pending: number | undefined;
  let prev: Cluster | null = null;

  const close = (end: End) => {
    if (cur.length > 0) {
      streams.push({ start: start ?? taggedEnd(cur[0]), end, pts: cur, settle, joined: [] });
      pending = undefined;
    }
    cur = [];
    start = null;
  };

  const clusters = clusterFixes(fixes, clusterRadiusM);
  clusters.forEach((c, index) => {
    const dwell = c.endMs - c.startMs;
    const first = c.points[0];
    const last = c.points[c.points.length - 1];
    const cen = centroid(c);

    if (prev && c.startMs - prev.endMs > longRestMs) {
      const seen = prev.points[prev.points.length - 1];
      close({ lat: seen.lat, lng: seen.lng, ms: seen.ms });
      settle = pending = c.startMs;
    }

    const lastCluster = index === clusters.length - 1;
    const home = dwell >= HOME_MIN_MS || lastCluster ? homeAt(cen.lat, cen.lng, dayOf(c.startMs)) : undefined;
    if (home || dwell > longRestMs) {
      stays.push({ lat: cen.lat, lng: cen.lng, start: iso(c.startMs), end: iso(c.endMs), kind: home ? 'home' : 'rest', ...(home ? { home: home.path } : {}) });
      const stay = stays.length - 1;
      close({ lat: cen.lat, lng: cen.lng, ms: c.startMs, stay });
      start = { lat: cen.lat, lng: cen.lng, ms: c.endMs, stay };
      // A home held only briefly at the end of the track may turn out to have been passed by.
      if (dwell >= HOME_MIN_MS || !home) settle = pending = c.startMs;
    } else {
      let stay: number | undefined;
      if (dwell >= OVERNIGHT_MIN_MS && dayOf(first.ms) !== dayOf(last.ms)) {
        stays.push({ lat: cen.lat, lng: cen.lng, start: iso(c.startMs), end: iso(c.endMs), kind: 'overnight' });
        stay = stays.length - 1;
      }
      for (const fix of c.points) {
        const t: Tagged = { fix, day: dayOf(fix.ms), lat: cen.lat, lng: cen.lng, ...(stay !== undefined ? { stay } : {}) };
        const before = cur[cur.length - 1];
        if (before && before.day !== t.day && splits.has(t.day)) {
          close(taggedEnd(before));
          start = taggedEnd(t);
        }
        if (!start && cur.length === 0) start = taggedEnd(t);
        cur.push(t);
      }
    }
    prev = c;
  });
  if (cur.length > 0) {
    const seen = cur[cur.length - 1];
    close({ lat: seen.lat, lng: seen.lng, ms: seen.fix.ms, open: true });
  }

  // --- Merges: a stream whose first fix is marked joins the one before it ---

  const joined: Stream[] = [];
  for (const s of streams) {
    const before = joined[joined.length - 1];
    const key = iso(s.pts[0].fix.ms);
    if (before && merges.has(key)) {
      before.pts = before.pts.concat(s.pts);
      before.end = s.end;
      before.joined.push(key);
    } else {
      joined.push(s);
    }
  }

  // The last stream's settle point holds while nothing joins it to the one before.
  const last = joined[joined.length - 1];
  const settledUntil = pending ?? last?.settle;

  // --- Each stream that went somewhere is a trip, one leg per local day ---

  const trips: Omit<Trip, 'albums'>[] = [];
  for (const s of joined) {
    if (s.pts.length < 2) continue;

    let maxDist = 0;
    let farthest = s.pts[0].fix;
    for (const t of s.pts) {
      const d = haversine(s.start.lat, s.start.lng, t.fix.lat, t.fix.lng);
      if (d > maxDist) {
        maxDist = d;
        farthest = t.fix;
      }
    }
    if (maxDist < MIN_TRIP_M) continue;

    const startMs = s.pts[0].fix.ms;
    const endMs = s.pts[s.pts.length - 1].fix.ms;
    let destination: Trip['destination'] = { lat: farthest.lat, lng: farthest.lng };
    let best = -1;
    let bestDist = 0;
    const consider = (index: number) => {
      const stay = stays[index];
      const d = haversine(s.start.lat, s.start.lng, stay.lat, stay.lng);
      if (best < 0 || d > bestDist) {
        best = index;
        bestDist = d;
      }
    };
    stays.forEach((stay, index) => {
      if (Date.parse(stay.start) >= startMs && Date.parse(stay.end) <= endMs) consider(index);
    });
    if (s.end.stay !== undefined) consider(s.end.stay);
    if (best >= 0 && bestDist >= MIN_TRIP_M) destination = { lat: stays[best].lat, lng: stays[best].lng, stay: best };

    const days: string[] = [];
    const byDay = new Map<string, Tagged[]>();
    for (const t of s.pts) {
      let list = byDay.get(t.day);
      if (!list) {
        byDay.set(t.day, list = []);
        days.push(t.day);
      }
      list.push(t);
    }

    const legs: Trip['legs'] = days.map((day, d) => {
      const tagged = byDay.get(day)!;
      const pts = tagged.map((t) => t.fix);
      // A day starts where the night before was spent, at its first fix.
      const from = d === 0 ? s.start : { ...placeOfNight(byDay.get(days[d - 1])!), ms: pts[0].ms };
      const to = d === days.length - 1 ? s.end : taggedEnd(tagged[tagged.length - 1]);
      // Its length runs from the night before's last fix, so a stretch across midnight is counted.
      const night = d === 0 ? [] : [byDay.get(days[d - 1])!.at(-1)!.fix];
      return {
        day,
        start: iso(pts[0].ms),
        end: iso(pts[pts.length - 1].ms),
        from: place(from),
        to: place(to),
        distanceM: lengthOf([...night, ...pts]),
        bounds: boundsOf(pts),
      };
    });

    const all = s.pts.map((t) => t.fix);
    trips.push({
      id: days[0],
      day: days[0],
      start: iso(startMs),
      end: iso(endMs),
      ongoing: s.end.open === true && now - endMs < ONGOING_MAX_AGE_MS,
      from: place(s.start),
      to: place(s.end),
      destination,
      distanceM: legs.reduce((sum, leg) => sum + leg.distanceM, 0),
      maxDistanceM: Math.round(maxDist),
      days,
      legs,
      bounds: boundsOf(all),
      ...(s.joined.length > 0 ? { joined: s.joined } : {}),
    });
  }

  return { trips: numberTrips(trips), stays, ...(settledUntil !== undefined ? { settledUntil } : {}) };
}

/** Trips in time order with their ids: the first local day, and `-2`, `-3` for further trips starting on it. */
export function numberTrips<T extends { id: string; day: string }>(trips: T[]): T[] {
  const perDay = new Map<string, number>();
  return trips.map((trip) => {
    const n = (perDay.get(trip.day) ?? 0) + 1;
    perDay.set(trip.day, n);
    return { ...trip, id: n === 1 ? trip.day : `${trip.day}-${n}` };
  });
}

/** Where the camera spent the night after a day: the place of that day's last fix. */
function placeOfNight(day: Tagged[]): Pick<End, 'lat' | 'lng' | 'stay'> {
  const t = day[day.length - 1];
  return { lat: t.lat, lng: t.lng, ...(t.stay !== undefined ? { stay: t.stay } : {}) };
}
