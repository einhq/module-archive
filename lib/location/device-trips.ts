/**
 * A device's trips and stays, kept as JSON in its `.trips` child (`@archive/location/device-trips`).
 *
 * `deriveDeviceTrips` cuts the track into trips (`@archive/location/trips`) with what the device
 * says of itself: the thresholds of its kind, its timezone, its homes and the edits in its attr
 * `tripEdits`. A run reads the track only from the last stay or gap that ended a trip for good
 * (`settledUntil`) and keeps what came before. It reads all of it when anything the trips were
 * derived with has changed, or when the track has more or fewer fixes before that point than it had.
 * A stay derived again from the same first fix keeps the location `track-places` gave it.
 * Whenever `.trips` is written, the albums made of the device's trips are written anew from it
 * (`@archive/media/trip-album`).
 */

import type { Command } from '@ein/client';
import type { DeviceTrips, Trip, TripEdits, TripPlace, TripStay } from '@archive/location/api';
import { readDeviceHomes } from '@archive/device/homes';
import { trackOf } from '@archive/location/track';
import { trackProfile } from '@archive/location/track-profile';
import { numberTrips, segmentTrips, type TripFix, type TripHome, type TripSegmentation, type TripSettings } from '@archive/location/trips';
import { albumDevices } from '@archive/media/album-devices';
import { refreshTripAlbums } from '@archive/media/trip-album';
import { NODE_TYPE_ALBUM } from '@archive/media/types';
import { AUTO_ORIGIN } from '@archive/staging/auto-album';

/** The device's child holding its trips. A dotfile, so nothing indexes it. */
const TRIPS_FILE = '.trips';
/** The device attr holding the edits made by hand. */
export const TRIP_EDITS_ATTR = 'tripEdits';

/** The track is read this many days at a time. */
const READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Albums per query page. */
const ALBUM_PAGE = 200;

const encoder = new TextEncoder();

type TrackReader = {
  readPoints(opts: { from?: string; to?: string }): Promise<{ segments: { points: { lat: number; lng: number; ts?: string }[] }[] }>;
  close(): Promise<void>;
};

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** The device's edits, as its attr holds them. */
export const tripEditsOf = (attrs: Record<string, unknown>): TripEdits => {
  const raw = (attrs[TRIP_EDITS_ATTR] ?? {}) as Record<string, unknown>;
  const merge = strings(raw.merge);
  const split = strings(raw.split);
  return { ...(merge.length ? { merge } : {}), ...(split.length ? { split } : {}) };
};

/** The device's trips as last derived, or undefined when they never were. */
export const readDeviceTrips = async (cmd: Command, device: string): Promise<DeviceTrips | undefined> => {
  const path = `${device}/${TRIPS_FILE}`;
  if (!(await cmd.sys.vfs.exists(cmd.access, path))) return undefined;
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    return JSON.parse(await new Response(handle.readable).text()) as DeviceTrips;
  } finally {
    await handle.close();
  }
};

/** Write the device's trips to its `.trips`, shared as the device is, and the albums made of them. */
export const writeDeviceTrips = async (cmd: Command, device: string, trips: DeviceTrips): Promise<void> => {
  const { mode, gid, acl } = (await cmd.sys.vfs.get(cmd.access, device)).props;
  await cmd.sys.vfs.ensure(cmd.access, 'file', device, TRIPS_FILE, { props: { mode, gid, ...(acl?.length ? { acl } : {}) }, attrs: { mimetype: 'application/json' } });
  const path = `${device}/${TRIPS_FILE}`;
  const bytes = encoder.encode(JSON.stringify(trips));
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
  await cmd.sys.vfs.update(cmd.access, path, { attrs: { size: bytes.length } });
  await refreshTripAlbums(cmd, trips);
};

/** Every fix at or after `from` (epoch ms), a window at a time, up to the track's last. */
const readFixes = async (handle: TrackReader, from: number, last: number): Promise<TripFix[]> => {
  const fixes: TripFix[] = [];
  for (let start = from; start <= last; start += READ_WINDOW_MS) {
    const read = await handle.readPoints({ from: new Date(start).toISOString(), to: new Date(start + READ_WINDOW_MS).toISOString() });
    for (const segment of read.segments) {
      for (const point of segment.points) if (point.ts) fixes.push({ ms: Date.parse(point.ts), lat: point.lat, lng: point.lng });
    }
  }
  // A segment carried over midnight starts on the day before's last fix, so a fix can come twice;
  // its time is the track's key, so one per time is the track as stored.
  fixes.sort((a, b) => a.ms - b.ms);
  return fixes.filter((fix, index) => index === 0 || fix.ms !== fixes[index - 1].ms);
};

/** Albums whose span overlaps the trip's days and whose devices include `device`. */
const candidateAlbums = async (cmd: Command, device: string, trip: Omit<Trip, 'albums'>, devicesOf: Map<string, Promise<string[]>>): Promise<string[]> => {
  const albums: string[] = [];
  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const rows = await cmd.sys.vfs.query(cmd.access, {
      types: [NODE_TYPE_ALBUM],
      where: [
        { ref: 'origin', op: 'ne', value: AUTO_ORIGIN },
        { ref: 'timeStart', op: 'lte', value: `${trip.days[trip.days.length - 1]}T23:59:59` },
        { ref: 'timeEnd', op: 'gte', value: trip.day },
      ],
      after,
      limit: ALBUM_PAGE,
    });
    for (const row of rows) {
      if (!devicesOf.has(row.absPath)) {
        devicesOf.set(row.absPath, albumDevices(cmd, row.absPath).then((list) => list.devices.map((entry) => entry.path), () => []));
      }
      if ((await devicesOf.get(row.absPath)!).includes(device)) albums.push(row.absPath);
    }
    if (rows.length < ALBUM_PAGE) return albums;
    after = { value: rows[rows.length - 1].sortValue, id: rows[rows.length - 1].id };
  }
};

/** A place with its stay index moved by `offset`. */
const shiftPlace = <T extends Pick<TripPlace, 'stay'>>(place: T, offset: number): T => place.stay === undefined ? place : { ...place, stay: place.stay + offset };

/** The stay with the place an earlier stay from the same fix was given, if any. */
const withPlace = (stay: TripStay, placed: Map<string, TripStay>): TripStay => {
  const earlier = placed.get(stay.start);
  if (!earlier) return stay;
  return { ...stay, ...(earlier.location ? { location: earlier.location } : {}), ...(earlier.unnamed ? { unnamed: true } : {}) };
};

/**
 * Derive the device's trips again (see the file comment), write them unless `dryRun`, and return
 * them. `target` is the device, by slug or path, or its track.
 */
export const deriveDeviceTrips = async (cmd: Command, target: string, opts: { full?: boolean; dryRun?: boolean; now?: number } = {}): Promise<DeviceTrips> => {
  const { path: trackPath, device } = await trackOf(cmd, target);
  const node = await cmd.sys.vfs.get(cmd.access, device);
  const attrs = node.attrs as Record<string, unknown>;
  const profile = trackProfile(attrs.kind);
  const timezone = typeof attrs.timezone === 'string' && attrs.timezone ? attrs.timezone : undefined;
  const edits = tripEditsOf(attrs);
  const homes: TripHome[] = (await readDeviceHomes(cmd, device)).homes.flatMap((home) =>
    home.lat === undefined || home.lng === undefined
      ? []
      : [{ lat: home.lat, lng: home.lng, path: home.location, ...(home.from ? { from: home.from } : {}), ...(home.to ? { to: home.to } : {}) }]
  );
  const settings: TripSettings = {
    clusterRadiusM: profile.clusterRadiusM,
    longRestMs: profile.longRestMs,
    ...(timezone ? { timezone } : {}),
    homes,
    edits,
    now: opts.now ?? Date.now(),
  };
  // What the trips are derived with, besides the track. Anything else reads the whole track.
  const basis = JSON.stringify({ clusterRadiusM: profile.clusterRadiusM, longRestMs: profile.longRestMs, timezone, homes, edits });

  const empty: DeviceTrips = { device, computedAt: new Date(settings.now!).toISOString(), basis, trips: [], stays: [] };
  if (!(await cmd.sys.vfs.exists(cmd.access, trackPath))) return empty;
  const trackId = (await cmd.sys.vfs.get(cmd.access, trackPath)).id;
  const summary = (await cmd.sys.vfs.trackSummaries(cmd.access, [trackId])).get(trackId);
  if (!summary?.firstTs || !summary.lastTs) return empty;

  const prior = await readDeviceTrips(cmd, device);
  const before = opts.full ? undefined : prior;
  const settled = before?.basis === basis && before.settledUntil ? Date.parse(before.settledUntil) : undefined;
  const handle = await cmd.sys.vfs.open(cmd.access, trackPath, { mode: 'r' }) as unknown as TrackReader;
  let previous: DeviceTrips | undefined;
  let fixes: TripFix[] = [];
  let seg: TripSegmentation = { trips: [], stays: [] };
  try {
    const readAll = async () => {
      fixes = await readFixes(handle, Date.parse(summary.firstTs!), Date.parse(summary.lastTs!));
      seg = segmentTrips(fixes, settings);
    };
    if (settled === undefined) {
      await readAll();
    } else {
      fixes = await readFixes(handle, settled, Date.parse(summary.lastTs));
      seg = segmentTrips(fixes, settings);
      // What is settled holds while the track has as many fixes before the settled point as it
      // had — none added, rejected or moved away — and the stay there, when it was a stay, still
      // starts there: a fix added at its start can make it begin later. Fixes appended since the
      // summary was read are not counted against it.
      const stay = before!.stays.find((entry) => Date.parse(entry.start) === settled);
      const summed = fixes.filter((fix) => fix.ms <= Date.parse(summary.lastTs!)).length;
      const holds = summary.points - summed === (before!.settledPoints ?? 0) &&
        (!stay || (seg.stays[0]?.start === stay.start && seg.stays[0].kind === stay.kind));
      if (holds) previous = before;
      else await readAll();
    }
  } finally {
    await handle.close();
  }

  const from = previous?.settledUntil ? Date.parse(previous.settledUntil) : -Infinity;
  const keptTrips = previous ? previous.trips.filter((trip) => Date.parse(trip.end) < from) : [];
  const keptStays = previous ? previous.stays.filter((stay) => Date.parse(stay.start) < from) : [];
  const offset = keptStays.length;

  // Where `track-places` placed a stay holds for the stay derived again from the same first fix.
  const placed = new Map((prior?.stays ?? []).filter((stay) => stay.location || stay.unnamed).map((stay) => [stay.start, stay]));

  const devicesOf = new Map<string, Promise<string[]>>();
  const derived: Trip[] = [];
  for (const trip of seg.trips) {
    derived.push({
      ...trip,
      from: shiftPlace(trip.from, offset),
      to: shiftPlace(trip.to, offset),
      destination: shiftPlace(trip.destination, offset),
      legs: trip.legs.map((leg) => ({ ...leg, from: shiftPlace(leg.from, offset), to: shiftPlace(leg.to, offset) })),
      albums: await candidateAlbums(cmd, device, trip, devicesOf),
    });
  }

  const settledUntil = seg.settledUntil ?? (previous ? from : undefined);
  const settledPoints = (previous?.settledPoints ?? 0) + (settledUntil === undefined ? 0 : fixes.filter((fix) => fix.ms < settledUntil).length);
  const trips: DeviceTrips = {
    device,
    computedAt: new Date(settings.now!).toISOString(),
    lastFix: summary.lastTs,
    ...(settledUntil !== undefined ? { settledUntil: new Date(settledUntil).toISOString(), settledPoints } : {}),
    basis,
    trips: numberTrips([...keptTrips, ...derived]),
    stays: [...keptStays, ...seg.stays.map((stay) => withPlace(stay, placed))],
  };
  if (!opts.dryRun) await writeDeviceTrips(cmd, device, trips);
  return trips;
};
