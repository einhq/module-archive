import { useCallback, useEffect, useRef, useState } from 'react';
import { useNodeEvents } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { TripList } from '@archive/location/api';

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

  return { trips, loading, error, refetch, edit, derive };
}
