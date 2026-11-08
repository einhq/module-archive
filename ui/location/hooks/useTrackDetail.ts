import { useCallback, useEffect, useState } from 'react';
import type { StatNode } from '@ein/ui/hooks';
import { type NodeOwnership, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { TrackEntry } from '@archive/location/api';

/** The settings `track-update` writes, as the form holds them: an empty string is none. */
export type TrackFields = {
  /** How it travels (`TravelKind`). */
  kind: string;
  /** The IANA timezone its trips are cut into days in. */
  timezone: string;
  description: string;
};

export type TrackDetail = TrackFields & {
  path: string;
  /** What `track-list` calls it: its own label, or the device or camera it belongs to. */
  name: string;
  points: number;
  firstTs?: string;
  lastTs?: string;
  ownership: NodeOwnership;
};

const str = (value: unknown): string => typeof value === 'string' ? value : '';

/**
 * One track for its page: what `track-list` says of it, its settings and who may change them, and
 * `save`, which writes the settings that changed through `track-update` (an emptied one is cleared)
 * and reads it again.
 */
export function useTrackDetail(path: string | undefined): {
  track: TrackDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  save: (fields: TrackFields) => Promise<void>;
} {
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!path) return;
    try {
      const [tracks, node] = await Promise.all([execCommand<TrackEntry[]>('track-list'), execCommand<StatNode>(`stat ${shq(path)}`)]);
      const entry = tracks.find((candidate) => candidate.path === path);
      if (!entry || node.type !== 'track') {
        setTrack(null);
        return;
      }
      setTrack({
        path,
        name: entry.name,
        points: entry.points,
        firstTs: entry.firstTs,
        lastTs: entry.lastTs,
        kind: str(node.attrs.kind),
        timezone: str(node.attrs.timezone),
        description: str(node.attrs.description),
        ownership: { mode: node.props.mode, uid: node.props.uid, gid: node.props.gid },
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTrack(null);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch]);

  const save = useCallback(async (fields: TrackFields) => {
    if (!path || !track) return;
    const parts: string[] = [];
    for (const key of ['kind', 'timezone', 'description'] as const) {
      const next = fields[key].trim();
      if (next === track[key].trim()) continue;
      parts.push(next === '' ? `--clear ${key}` : `--${key} ${shq(next)}`);
    }
    if (parts.length > 0) await execCommand(`track-update ${shq(path)} ${parts.join(' ')}`);
    await refetch();
  }, [path, track, refetch]);

  return { track, loading, error, refetch, save };
}
