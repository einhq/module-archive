import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { AlbumInfoAnswer } from '@archive/media/api';

/** One of an album's neighbours in a series: where it is and what it is called. */
export type SeriesNeighbour = { path: string; title: string };

export type AlbumSeries = { previous?: SeriesNeighbour; next?: SeriesNeighbour };

/**
 * The albums before and after `path` in a series, as its `previous` and `next` links name them.
 *
 * Two `album info` calls: the album's own, for where its links point, and one for both neighbours,
 * for their titles. A link left pointing at an album that is gone is no neighbour.
 */
export function useAlbumSeries(path: string): { series: AlbumSeries; refetch: () => void } {
  const [series, setSeries] = useState<AlbumSeries>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSeries({});
    if (!path) return;

    (async () => {
      const own = await execCommand<AlbumInfoAnswer>(`album info ${shq(path)}`);
      const { previous, next } = own.albums[0] ?? {};
      const linked = [previous, next].filter((each): each is string => Boolean(each));
      if (linked.length === 0 || cancelled) return;
      const neighbours = await execCommand<AlbumInfoAnswer>(`album info ${linked.map(shq).join(' ')}`);
      const neighbour = (at: string | null | undefined): SeriesNeighbour | undefined => {
        const found = at ? neighbours.albums.find((album) => album.path === at) : undefined;
        return found ? { path: found.path, title: found.title } : undefined;
      };
      if (!cancelled) setSeries({ previous: neighbour(previous), next: neighbour(next) });
    })().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [path, version]);

  return { series, refetch: () => setVersion((value) => value + 1) };
}
