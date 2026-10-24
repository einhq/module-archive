import type { AlbumScores } from '@archive/media/api';
import type { GroupKind } from '@archive/staging/api';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { isSuggestedAlbum } from '../lib/album-origin.ts';

/**
 * An auto album is an `album` node marked `attrs.origin='auto'`, made by the
 * staging organizer. Its grouping metadata lives in `attrs.autoAlbum`.
 */
type AutoAlbumMeta = {
  timeStart?: string;
  timeEnd?: string;
  locationPath?: string;
  memberCount?: number;
  scores?: AlbumScores;
  /** Some member is still waiting on the crawl; membership may still change. */
  provisional?: boolean;
  /** A person pinned or hand-edited it; the organizer leaves it alone. */
  pinned?: boolean;
  /** What kind of grouping it is; a trip is a run of days away from home, rolled up from its day-parts. */
  kind?: GroupKind;
  /** Distinct days the members fall on. */
  days?: number;
  /** Far from the usual location. */
  away?: boolean;
  /** The day-parts this was rolled up from, when it was. */
  parts?: { timeStart: string; timeEnd: string; memberCount: number }[];
};

type AutoAlbumEntry = {
  /** Node slug. */
  name: string;
  path: string;
  displayName: string;
  description?: string;
  labels?: string[];
  timeStart?: string;
  timeEnd?: string;
  locationPath?: string;
  locationName?: string;
  memberCount?: number;
  /** Full per-signal breakdown, so the detail header can explain the grouping. */
  scores?: AlbumScores;
  overall?: number;
  provisional?: boolean;
  pinned?: boolean;
  kind?: 'trip';
  days?: number;
  parts?: number;
  modtime?: number;
};

type AutoAlbumAttrs = { name?: string; description?: string; labels?: string[]; autoAlbum?: AutoAlbumMeta };

const toEntry = (name: string, path: string, attrs: AutoAlbumAttrs, modtime?: number): AutoAlbumEntry => {
  const meta = attrs.autoAlbum ?? {};
  return {
    name,
    path,
    displayName: attrs.name || name,
    description: attrs.description,
    labels: attrs.labels,
    timeStart: meta.timeStart,
    timeEnd: meta.timeEnd,
    locationPath: meta.locationPath,
    locationName: meta.locationPath?.split('/').pop(),
    memberCount: meta.memberCount,
    scores: meta.scores,
    overall: meta.scores?.overall,
    provisional: meta.provisional,
    pinned: meta.pinned,
    kind: meta.kind === 'trip' ? 'trip' : undefined,
    days: meta.days,
    parts: meta.parts?.length,
    modtime,
  };
};

/** Rename an auto album, or pin it so the organizer stops managing it (`staging rename|pin`). */
export async function renameAutoAlbum(path: string, name: string): Promise<void> {
  await execCommand(`staging rename ${shq(path)} ${shq(name)}`);
}

export async function setAutoAlbumPinned(path: string, pinned: boolean): Promise<void> {
  await execCommand(`staging pin ${shq(path)}${pinned ? '' : ' --off'}`);
}

/** Load a single auto album's metadata for its detail header. */
export function useAutoAlbum(path: string): { autoAlbum: AutoAlbumEntry | null; loading: boolean; refetch: () => void } {
  const [autoAlbum, setAutoAlbum] = useState<AutoAlbumEntry | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const attrs = await execCommand<AutoAlbumAttrs & { origin?: string }>(`attrs ${shq(path)}`);
      if (!isSuggestedAlbum(attrs.origin)) {
        setAutoAlbum(null);
      } else {
        setAutoAlbum(toEntry(path.split('/').pop() || path, path, attrs));
      }
    } catch {
      setAutoAlbum(null);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetch();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [fetch]);

  return { autoAlbum, loading, refetch: fetch };
}
