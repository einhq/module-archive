import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { AlbumDeviceList } from '@archive/media/api';

/**
 * The devices whose tracks an album's map draws (`album-device-list`), and adding a device to the
 * list or removing one from it; `list` is null while it is asked, or when it could not be.
 */
export function useAlbumDevices(path: string): {
  list: AlbumDeviceList | null;
  loading: boolean;
  add: (device: string) => Promise<void>;
  remove: (device: string) => Promise<void>;
} {
  const [list, setList] = useState<AlbumDeviceList | null>(null);
  const [loading, setLoading] = useState(true);
  // An answer about an album the page has since left is dropped.
  const current = useRef(path);
  current.current = path;

  const read = useCallback(async () => {
    const answer = await execCommand<AlbumDeviceList>(`album-device-list ${shq(path)}`).catch(() => null);
    if (current.current !== path) return;
    setList(answer);
    setLoading(false);
  }, [path]);

  useEffect(() => {
    setList(null);
    setLoading(true);
    void read();
  }, [read]);

  const add = useCallback(async (device: string) => {
    await execCommand(`album-device-add ${shq(path)} ${shq(device)}`);
    await read();
  }, [path, read]);

  const remove = useCallback(async (device: string) => {
    await execCommand(`album-device-rm ${shq(path)} ${shq(device)}`);
    await read();
  }, [path, read]);

  return { list, loading, add, remove };
}
