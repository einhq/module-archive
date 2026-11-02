import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { DeviceHome, DeviceHomes } from '@archive/device/api';

/** A device's home bases (`device-home`), or its owners' homes when it lists none, and the writes that change them. */
export function useDeviceHomes(path: string | undefined): {
  homes: DeviceHome[];
  loading: boolean;
  add: (location: string) => Promise<void>;
  remove: (location: string) => Promise<void>;
} {
  const [homes, setHomes] = useState<DeviceHome[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHomes = useCallback(async () => {
    if (!path) return;
    try {
      setLoading(true);
      setHomes((await execCommand<DeviceHomes>(`device-home ${shq(path)} list`)).homes);
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
    await execCommand(`device-home ${shq(path)} add ${shq(location)}`);
    await fetchHomes();
  }, [path, fetchHomes]);

  const remove = useCallback(async (location: string) => {
    if (!path) return;
    await execCommand(`device-home ${shq(path)} rm ${shq(location)}`);
    await fetchHomes();
  }, [path, fetchHomes]);

  return { homes, loading, add, remove };
}
