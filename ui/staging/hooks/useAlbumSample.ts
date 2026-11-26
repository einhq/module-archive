import type { SearchResponse } from '@ein/api';
import { mediaItemFrom, shq } from '@ein/ui/lib';
import { execCommand, type MediaItem } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import { dayAfter, seekDay } from '../lib/album-days.ts';

/** A search hit as a picture of a grid. */
const itemOf = (hit: SearchResponse['results'][number]): MediaItem =>
  mediaItemFrom({
    path: hit.path,
    ...(hit.memberPath ? { memberPath: hit.memberPath } : {}),
    name: hit.name,
    ...(hit.mimetype ? { mimetype: hit.mimetype } : {}),
    ...(hit.takenAt ? { takenAt: hit.takenAt } : {}),
    ...(hit.width ? { width: hit.width } : {}),
    ...(hit.height ? { height: hit.height } : {}),
    ...(hit.angle ? { angle: hit.angle } : {}),
    ...(hit.duration ? { duration: hit.duration } : {}),
    ...(hit.stackCount ? { stackCount: hit.stackCount } : {}),
    ownership: hit.ownership,
  });

/** The reads `useAlbumSample` tries in turn, until one finds pictures: each a `search --under <album>`. */
const sampleReads = (timeStart: string | undefined, timeEnd: string | undefined): string[] => {
  const after = dayAfter(timeEnd ?? timeStart);
  const before = seekDay(timeStart);
  return [
    ...(after ? [`--sort -time --at ${after}`] : []),
    ...(before ? [`--sort time --at ${before}`] : []),
    '--sort time',
  ];
};

/**
 * A few of `album`'s own pictures, as near the group's days (`timeStart` to `timeEnd`) as it has
 * them, oldest first: those up to the group's last day, nearest first; else, for an album that
 * starts after the group, those from its days on; else (an undated group, or an album of undated
 * pictures) its first ones. `loaded` once a read has answered.
 */
export function useAlbumSample(album: string, timeStart: string | undefined, timeEnd: string | undefined, limit: number) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError(null);
    (async () => {
      for (const read of sampleReads(timeStart, timeEnd)) {
        const answer = await execCommand<SearchResponse>(`search --under ${shq(album)} ${read} -l ${limit}`, { signal: controller.signal });
        if (answer.results.length === 0) continue;
        const found = answer.results.map(itemOf);
        return read.includes('-time') ? found.reverse() : found;
      }
      return [];
    })()
      .then((found) => {
        if (controller.signal.aborted) return;
        setItems(found);
        setLoaded(true);
      })
      .catch((value) => !controller.signal.aborted && setError(value instanceof Error ? value.message : String(value)));
    return () => controller.abort();
  }, [album, timeStart, timeEnd, limit]);

  return { items, loaded, error };
}
