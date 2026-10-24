import type { DuplicatePage, DuplicateSet } from '@archive/media/api';
import type { MediaItem } from '@ein/ui/signals';
import { execCommand } from '@ein/ui/signals';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FILE_SETS_READ, fileDuplicates, setsCommand, type TileBadge } from '../lib/duplicate-sets.ts';

/** How long tiles drawn are gathered before their sets are asked for: one read for a screenful, not one per tile. */
const GATHER_MS = 120;

type Found = { badges: Map<string, TileBadge>; setOf: Map<string, DuplicateSet> };

const empty = (): Found => ({ badges: new Map(), setOf: new Map() });

/**
 * The duplicate badges of staged files as their tiles are drawn: `badge` is asked for each tile a
 * grid draws, and the files asked for are read together (`staging duplicates <file>…`, at most
 * `FILE_SETS_READ` a call) once drawing settles; what each file's badge is, and `setOf` its set, by
 * path, is `fileDuplicates`. Everything is read again when `reloadToken` changes or `reread` is called; a
 * file that cannot be read stays without a badge.
 */
export function useFileDuplicates(reloadToken: number): {
  badge: (item: MediaItem) => TileBadge | undefined;
  setOf: (path: string) => DuplicateSet | undefined;
  reread: () => void;
} {
  const [found, setFound] = useState<Found>(empty);
  const [generation, setGeneration] = useState(0);
  const asked = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controller = useRef(new AbortController());

  const reread = useCallback(() => setGeneration((value) => value + 1), []);

  // A new read forgets what the last one found and gives up what it still had in flight.
  const read = useRef(`${reloadToken}:${generation}`);
  if (read.current !== `${reloadToken}:${generation}`) {
    read.current = `${reloadToken}:${generation}`;
    controller.current.abort();
    controller.current = new AbortController();
    clearTimeout(timer.current);
    timer.current = undefined;
    asked.current = new Set();
    queue.current = new Set();
  }
  useEffect(() => setFound(empty()), [reloadToken, generation]);
  useEffect(() => () => {
    controller.current.abort();
    clearTimeout(timer.current);
  }, []);

  const flush = useCallback(() => {
    timer.current = undefined;
    const files = [...queue.current];
    queue.current = new Set();
    const { signal } = controller.current;
    for (let i = 0; i < files.length; i += FILE_SETS_READ) {
      const chunk = files.slice(i, i + FILE_SETS_READ);
      execCommand<DuplicatePage>(setsCommand(...chunk), { signal })
        .then((page) => {
          if (signal.aborted) return;
          const view = fileDuplicates(page.sets, new Set(chunk));
          if (view.badges.size === 0) return;
          setFound((previous) => ({
            badges: new Map([...previous.badges, ...view.badges]),
            setOf: new Map([...previous.setOf, ...view.setOf]),
          }));
        })
        .catch(() => {});
    }
  }, []);

  // Called while a grid draws its tiles: a file not asked for yet is queued, and the read is set off
  // a moment later. Drawing again asks nothing new, so the render stays without effects of its own.
  const badge = useCallback((item: MediaItem): TileBadge | undefined => {
    if (!asked.current.has(item.path)) {
      asked.current.add(item.path);
      queue.current.add(item.path);
      timer.current ??= setTimeout(flush, GATHER_MS);
    }
    return found.badges.get(item.path);
  }, [found, flush]);

  const setOf = useCallback((path: string) => found.setOf.get(path), [found]);

  return { badge, setOf, reread };
}
