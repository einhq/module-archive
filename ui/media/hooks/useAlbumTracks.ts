import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { AlbumTrackList } from '@archive/media/api';

/**
 * The tracks an album's map draws (`album-track-list`), and adding a track to the list or removing
 * one from it; `list` is null while it is asked, or when it could not be.
 */
export function useAlbumTracks(path: string): {
  list: AlbumTrackList | null;
  loading: boolean;
  add: (track: string) => Promise<void>;
  remove: (track: string) => Promise<void>;
} {
  const [list, setList] = useState<AlbumTrackList | null>(null);
  const [loading, setLoading] = useState(true);
  // An answer about an album the page has since left is dropped.
  const current = useRef(path);
  current.current = path;

  const read = useCallback(async () => {
    const answer = await execCommand<AlbumTrackList>(`album-track-list ${shq(path)}`).catch(() => null);
    if (current.current !== path) return;
    setList(answer);
    setLoading(false);
  }, [path]);

  useEffect(() => {
    setList(null);
    setLoading(true);
    void read();
  }, [read]);

  const add = useCallback(async (track: string) => {
    await execCommand(`album-track-add ${shq(path)} ${shq(track)}`);
    await read();
  }, [path, read]);

  const remove = useCallback(async (track: string) => {
    await execCommand(`album-track-rm ${shq(path)} ${shq(track)}`);
    await read();
  }, [path, read]);

  return { list, loading, add, remove };
}
