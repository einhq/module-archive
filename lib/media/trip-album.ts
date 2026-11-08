/**
 * The trip of a track an album was made (`@archive/media/trip-album`): its attr `trip`
 * (`AlbumTrip`), written from the trips `track-trips` derived, found again by track through the
 * `trip_track` index, and written anew whenever the track's trips are.
 */

import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import type { TrackTrips, Trip, TripStay } from '@archive/location/api';
import type { AlbumTrip } from '@archive/media/api';
import { NODE_TYPE_ALBUM } from '@archive/media/types';

/** The album attr holding the trip. */
export const TRIP_ATTR = 'trip';

/** Albums per query page. */
const ALBUM_PAGE = 200;

/** An album holding a trip of the track, and the trip as it holds it. */
type TripAlbum = { path: string; trip: AlbumTrip };

/**
 * The trip as an album keeps it: with the stays it names (where it and its legs start and end, and
 * where it got farthest) and the stays along the way, numbered anew in the order they came.
 */
export const albumTripOf = (track: string, timezone: string | undefined, trip: Trip, stays: TripStay[]): AlbumTrip => {
  const start = Date.parse(trip.start);
  const end = Date.parse(trip.end);
  const named = new Set<number>();
  for (const place of [trip.from, trip.to, trip.destination, ...trip.legs.flatMap((leg) => [leg.from, leg.to])]) {
    if (place.stay !== undefined && stays[place.stay]) named.add(place.stay);
  }
  stays.forEach((stay, index) => {
    if (Date.parse(stay.start) >= start && Date.parse(stay.end) <= end) named.add(index);
  });
  const kept = [...named].sort((a, b) => a - b);
  const renumbered = new Map(kept.map((old, index) => [old, index]));
  const place = <T extends { stay?: number }>(at: T): T => {
    if (at.stay === undefined) return at;
    const { stay, ...rest } = at;
    const index = renumbered.get(stay);
    return (index === undefined ? rest : { ...rest, stay: index }) as T;
  };
  return {
    track,
    day: trip.day,
    start: trip.start,
    end: trip.end,
    ...(timezone ? { timezone } : {}),
    ongoing: trip.ongoing,
    from: place(trip.from),
    to: place(trip.to),
    destination: place(trip.destination),
    stays: kept.map((index) => stays[index]),
    legs: trip.legs.map((leg) => ({ ...leg, from: place(leg.from), to: place(leg.to) })),
    distanceM: trip.distanceM,
    ...(trip.weather ? { weather: trip.weather } : {}),
  };
};

/** The trip `name` names: its id (`trip-list`), or its first day. */
export const tripNamed = (trips: Trip[], name: string): Trip | undefined => trips.find((trip) => trip.id === name) ?? trips.find((trip) => trip.day === name);

/**
 * Of `trips`, the one that a trip kept as `held` now is: the one starting when it did, or else the
 * one sharing the most time with it. Trips joined or parted since it was kept still find theirs.
 */
export const matchTrip = (trips: Trip[], held: Pick<AlbumTrip, 'start' | 'end'>): Trip | undefined => {
  const same = trips.find((trip) => trip.start === held.start);
  if (same) return same;
  const start = Date.parse(held.start);
  const end = Date.parse(held.end);
  let best: Trip | undefined;
  let bestOverlap = 0;
  for (const trip of trips) {
    const overlap = Math.min(end, Date.parse(trip.end)) - Math.max(start, Date.parse(trip.start));
    if (overlap > bestOverlap) {
      best = trip;
      bestOverlap = overlap;
    }
  }
  return best;
};

/** The albums holding a trip of `track`. */
export const tripAlbums = async (cmd: Command, track: string): Promise<TripAlbum[]> => {
  const albums: TripAlbum[] = [];
  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const rows = await cmd.sys.vfs.query(cmd.access, {
      types: [NODE_TYPE_ALBUM],
      where: [{ ref: { path: [TRIP_ATTR, 'track'] }, op: 'eq', value: track }],
      after,
      limit: ALBUM_PAGE,
    });
    for (const row of rows) albums.push({ path: row.absPath, trip: row.node.attrs[TRIP_ATTR] as AlbumTrip });
    if (rows.length < ALBUM_PAGE) return albums;
    after = { value: rows[rows.length - 1].sortValue, id: rows[rows.length - 1].id };
  }
};

/** Write the album's trip, or take it away with `null`, and its span again, which the trip widens. */
export const writeAlbumTrip = async (cmd: Command, album: string, trip: AlbumTrip | null): Promise<void> => {
  await cmd.sys.vfs.update(cmd.access, album, { attrs: { [TRIP_ATTR]: trip } });
  const span = await cmd.execute(`album-span ${shq(album)}`);
  if (span.code !== 0) throw new Error(span.stderr.trim() || `${album}: cannot write its span`);
};

/**
 * Write anew the trip of each album holding one of the track's trips, from its trips as they are
 * now: the album grows with an ongoing trip and learns when it ended, follows a trip joined or
 * parted, and gets the locations its stays were put at. An album whose trip is no longer found keeps
 * it as it was. What could not be written is said on stderr.
 */
export const refreshTripAlbums = async (cmd: Command, trips: TrackTrips): Promise<void> => {
  const albums = await tripAlbums(cmd, trips.track);
  if (albums.length === 0) return;
  const timezone = (await cmd.sys.vfs.get(cmd.access, trips.track)).attrs.timezone;
  for (const album of albums) {
    const trip = matchTrip(trips.trips, album.trip);
    if (!trip) continue;
    const next = albumTripOf(trips.track, typeof timezone === 'string' && timezone ? timezone : undefined, trip, trips.stays);
    if (JSON.stringify(next) === JSON.stringify(album.trip)) continue;
    try {
      await writeAlbumTrip(cmd, album.path, next);
    } catch (error) {
      await cmd.writeError(`${album.path}: cannot write its trip: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
};
