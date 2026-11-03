import { useCallback, useEffect, useRef, useState } from 'react';
import { useNodeEvents } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { Trip, TripList } from '@archive/location/api';
import type { TripAlbumAnswer } from '@archive/media/api';

/** The child `track-trips` keeps a device's trips in. */
const TRIPS_FILE = '.trips';

type UseDeviceTrips = {
  trips: TripList | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Join the trip to the one before it (`--merge`), or part the track on a day (`--split`). */
  edit: (trip: string, how: 'merge' | 'split') => Promise<void>;
  /** Derive them again from the whole track. */
  derive: () => Promise<void>;
  /**
   * Make the trip an album: a new one (named `name`, or after the trip), one that is there by its
   * path, or none (`detach`); answers the album.
   */
  makeAlbum: (trip: string, album: 'new' | 'detach' | string, name?: string) => Promise<string>;
  /** Move the trip's fixes, first to last, to the device at `to`, and find the trips of both again. */
  move: (trip: Trip, to: string) => Promise<void>;
};

/** A device's trips as `trip-list` gives them, read again whenever its `.trips` is written. */
export function useDeviceTrips(devicePath: string): UseDeviceTrips {
  const [trips, setTrips] = useState<TripList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refetch = useCallback(() => {
    setLoading(true);
    execCommand<TripList>(`trip-list ${shq(devicePath)}`)
      .then((list) => {
        if (!mounted.current) return;
        setTrips(list);
        setError(null);
      })
      .catch((err) => mounted.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => mounted.current && setLoading(false));
  }, [devicePath]);

  useEffect(() => {
    mounted.current = true;
    refetch();
    return () => {
      mounted.current = false;
    };
  }, [refetch]);

  useNodeEvents({ pathPrefix: devicePath, recursive: false, nodeTypes: ['file'], eventTypes: ['created', 'updated'] }, (event) => {
    if (event.path === `${devicePath}/${TRIPS_FILE}`) refetch();
  });

  const edit = useCallback(async (trip: string, how: 'merge' | 'split') => {
    await execCommand(`trip-edit ${shq(devicePath)} ${shq(trip)} --${how}`);
    refetch();
  }, [devicePath, refetch]);

  const derive = useCallback(async () => {
    await execCommand(`track-trips ${shq(devicePath)} --full`);
    refetch();
  }, [devicePath, refetch]);

  const makeAlbum = useCallback(async (trip: string, album: 'new' | 'detach' | string, name?: string) => {
    const how = album === 'new' ? `--new${name ? ` --name=${shq(name)}` : ''}` : album === 'detach' ? '--detach' : `--album=${shq(album)}`;
    const answer = await execCommand<TripAlbumAnswer>(`trip-album ${shq(devicePath)} ${shq(trip)} ${how}`);
    refetch();
    return answer.album;
  }, [devicePath, refetch]);

  const move = useCallback(async (trip: Trip, to: string) => {
    const end = new Date(Date.parse(trip.end) + 1).toISOString();
    await execCommand(`track-move ${shq(devicePath)} ${shq(to)} --from=${trip.start} --to=${end}`);
    await execCommand(`track-trips ${shq(devicePath)}`);
    await execCommand(`track-trips ${shq(to)}`);
    refetch();
  }, [devicePath, refetch]);

  return { trips, loading, error, refetch, edit, derive, makeAlbum, move };
}
