import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { TrackHome, TrackHomes } from '@archive/location/api';

/**
 * A track's home bases (`track-home`), or, when it lists none, the homes of the owners of the
 * cameras that record into it, and the writes that change them.
 */
export function useTrackHomes(path: string | undefined): {
  homes: TrackHome[];
  loading: boolean;
  add: (location: string) => Promise<void>;
  remove: (location: string) => Promise<void>;
} {
  const [homes, setHomes] = useState<TrackHome[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHomes = useCallback(async () => {
    if (!path) return;
    try {
      setLoading(true);
      setHomes((await execCommand<TrackHomes>(`track-home ${shq(path)}`)).homes);
    } catch {
      setHomes([]);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    fetchHomes();
  }, [fetchHomes]);

  const add = useCallback(async (location: string) => {
    if (!path) return;
    await execCommand(`track-home ${shq(path)} --add ${shq(location)}`);
    await fetchHomes();
  }, [path, fetchHomes]);

  const remove = useCallback(async (location: string) => {
    if (!path) return;
    await execCommand(`track-home ${shq(path)} --remove ${shq(location)}`);
    await fetchHomes();
  }, [path, fetchHomes]);

  return { homes, loading, add, remove };
}
