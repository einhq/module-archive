import { useCallback, useEffect, useState } from 'react';
import type { StatNode } from '@ein/ui/hooks';
import { type NodeOwnership, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { TrackEntry } from '@archive/location/api';

/** The settings `track-update` writes, as the form holds them: an empty string is none. */
export type TrackFields = {
  /** How it travels (`TravelKind`), its own: none reads its device's class. */
  kind: string;
  /** The IANA timezone its trips are cut into days in. */
  timezone: string;
  description: string;
};

export type TrackDetail = TrackFields & {
  path: string;
  /** What `track-list` calls it: its device's label. */
  name: string;
  /** The device it is the track of, when it is one's. */
  device?: string;
  /** How it travels as `track-list` reads it: its own kind, else its device's class when that is one. */
  travels?: string;
  points: number;
  firstTs?: string;
  lastTs?: string;
  ownership: NodeOwnership;
};

const str = (value: unknown): string => typeof value === 'string' ? value : '';

/** A device's position, or its only track, of the tracks under it. */
const trackOf = (tracks: TrackEntry[], target: string): TrackEntry | undefined =>
  tracks.find((entry) => entry.path === target) ?? tracks.find((entry) => entry.path === `${target}/position`) ?? (tracks.length === 1 ? tracks[0] : undefined);

/**
 * The track of a device for its Trips tab, `target` the device's path (or the track's): what
 * `track-list` says of it, its settings and who may change them, and `save`, which writes the
 * settings that changed through `track-update` (an emptied one is cleared) and reads it again.
 */
export function useTrackDetail(target: string | undefined): {
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
    if (!target) return;
    try {
      const entry = trackOf(await execCommand<TrackEntry[]>(`track-list ${shq(target)}`), target);
      const node = entry && await execCommand<StatNode>(`stat ${shq(entry.path)}`);
      if (!entry || !node || node.type !== 'track') {
        setTrack(null);
        return;
      }
      setTrack({
        path: entry.path,
        name: entry.name,
        ...(entry.device ? { device: entry.device } : {}),
        ...(entry.kind ? { travels: entry.kind } : {}),
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
  }, [target]);

  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch]);

  const save = useCallback(async (fields: TrackFields) => {
    if (!track) return;
    const parts: string[] = [];
    for (const key of ['kind', 'timezone', 'description'] as const) {
      const next = fields[key].trim();
      if (next === track[key].trim()) continue;
      parts.push(next === '' ? `--clear ${key}` : `--${key} ${shq(next)}`);
    }
    if (parts.length > 0) await execCommand(`track-update ${shq(track.path)} ${parts.join(' ')}`);
    await refetch();
  }, [track, refetch]);

  return { track, loading, error, refetch, save };
}
