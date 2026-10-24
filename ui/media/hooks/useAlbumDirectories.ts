import { useCallback, useEffect, useState } from 'react';
import { DirectoryEntry, execCommand } from '@ein/ui/signals';
import { isDirectory, type NodeChildEntry, shq, transformToDirectory } from '@ein/ui/lib';
import { albumContentDir } from '../lib/album-path.ts';

type UseAlbumDirectoriesResult = {
  directories: DirectoryEntry[];
  /**
   * The directory the folder cards were read from — the album itself, or its
   * `files/` child when the media sits there. Where an upload belongs, so the
   * page gets it without a second listing.
   */
  contentPath: string;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * The subfolders of an album, as folder cards.
 *
 * The media is *not* listed here — it comes from `search --under`, which orders
 * it by capture time and pages it. This is only the structure the grid cannot
 * express.
 *
 * An imported album keeps its media in a lone `files/` child. Showing that as a
 * folder and making the user click it adds nothing, so an album with no media of
 * its own descends into it and reports *its* subfolders.
 */
export function useAlbumDirectories(albumPath: string): UseAlbumDirectoriesResult {
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [contentPath, setContentPath] = useState(albumPath);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchDirectories = useCallback(async () => {
    if (!albumPath) {
      setDirectories([]);
      setContentPath(albumPath);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      let dir = albumPath;
      let children = await execCommand<NodeChildEntry[]>(`ls -l ${shq(dir)}`);

      const contentDir = albumContentDir(albumPath, children);
      if (contentDir !== dir) {
        dir = contentDir;
        children = await execCommand<NodeChildEntry[]>(`ls -l ${shq(dir)}`);
      }

      setContentPath(dir);
      // `events/` is album metadata rendered in the timeline, not a browseable
      // subfolder beside the album's actual media structure.
      setDirectories(children.filter((entry) => entry.name !== 'events' && isDirectory(entry)).map((entry) => transformToDirectory(entry, dir)));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setDirectories([]);
      setContentPath(albumPath);
    } finally {
      setLoading(false);
    }
  }, [albumPath]);

  useEffect(() => {
    fetchDirectories();
  }, [fetchDirectories]);

  return { directories, contentPath, loading, error, refetch: fetchDirectories };
}
