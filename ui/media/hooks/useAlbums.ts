import { type AlbumEntry } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { useCallback, useEffect, useState } from 'react';
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumListResult } from '@archive/media/api';

type UseAlbumsResult = {
  albums: AlbumEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * List album directories under a media root, by title. The server returns compact pages in its
 * own name order, so the order is set here once every page is in: covers and item counts are
 * still loaded per card and lazily (useAlbumCover), while full node props and child arrays never
 * cross the API shell.
 */
export function useAlbums(rootPath: string = ALBUMS_ROOT): UseAlbumsResult {
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAlbums = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const entries: AlbumEntry[] = [];
      let cursor: string | null = null;
      do {
        const page: AlbumListResult = await execCommand<AlbumListResult>(
          `album list ${shq(rootPath)}${cursor === null ? '' : ` --cursor=${shq(cursor)}`}`,
        );
        entries.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);

      setAlbums(entries.sort((a, b) => a.title.localeCompare(b.title)));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setAlbums([]);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    fetchAlbums();
  }, [fetchAlbums]);

  return { albums, loading, error, refetch: fetchAlbums };
}
