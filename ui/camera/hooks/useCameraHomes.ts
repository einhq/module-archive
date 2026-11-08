import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { CameraHome, CameraHomes } from '@archive/camera/api';

/** A camera's home bases (`camera-home`), or its owners' homes when it lists none, and the writes that change them. */
export function useCameraHomes(path: string | undefined): {
  homes: CameraHome[];
  loading: boolean;
  add: (location: string) => Promise<void>;
  remove: (location: string) => Promise<void>;
} {
  const [homes, setHomes] = useState<CameraHome[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHomes = useCallback(async () => {
    if (!path) return;
    try {
      setLoading(true);
      setHomes((await execCommand<CameraHomes>(`camera-home ${shq(path)} list`)).homes);
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
    await execCommand(`camera-home ${shq(path)} add ${shq(location)}`);
    await fetchHomes();
  }, [path, fetchHomes]);

  const remove = useCallback(async (location: string) => {
    if (!path) return;
    await execCommand(`camera-home ${shq(path)} rm ${shq(location)}`);
    await fetchHomes();
  }, [path, fetchHomes]);

  return { homes, loading, add, remove };
}
