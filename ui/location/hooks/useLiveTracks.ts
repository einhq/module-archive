import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CAMERAS_ROOT } from '@archive/paths';
import { useNodeEvents } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, shellClientEpoch } from '@ein/ui/signals';
import type { TrackEntry, TrackPoint, TrackRead } from '@archive/location/api';
import { appendFixes, isLive } from '../lib/live.ts';

/** A camera whose track is live, and where it has been since the page opened. */
export type LiveTrack = {
  track: TrackEntry;
  /** The last fix known when the track was first read here, then every fix since, oldest first. */
  points: TrackPoint[];
  /** The newest of `points`: where the camera is now. */
  last: TrackPoint;
};

/** The newest fix known of `track`: the list's, or a newer one read here since. */
function latestTs(track: TrackEntry, fixes: ReadonlyMap<string, TrackPoint[]>): string | undefined {
  const read = fixes.get(track.path)?.at(-1)?.ts;
  if (!read || !track.lastTs) return read ?? track.lastTs;
  return Date.parse(read) >= Date.parse(track.lastTs) ? read : track.lastTs;
}

/** How often the clock behind `now` ticks while anything is live, so ages and liveness stay current. */
const TICK_MS = 5000;

/** A track the list did not have as live is listed again at most this often. */
const RELIST_MS = 10_000;

/**
 * The tracks among `tracks` that are live — their last fix is under four hours old — kept current
 * as they grow.
 *
 * One subscription to `updated` events on the tracks under the cameras root: an event for a live
 * track reads it from its last fix on (`track-read --from --still`, which drops a new fix that is a
 * spike) and appends what is new; an event for
 * any other track asks for the list again through `relist`, since that track may just have woken
 * up. A reconnect reads every live track again, since events may have been missed. `now` is the
 * clock the liveness was judged by, for the ages shown beside it.
 */
export function useLiveTracks(tracks: TrackEntry[], relist: () => void): { live: LiveTrack[]; now: number } {
  const [now, setNow] = useState(() => Date.now());
  const [fixes, setFixes] = useState<ReadonlyMap<string, TrackPoint[]>>(new Map());
  const fixesRef = useRef(fixes);
  fixesRef.current = fixes;

  // Reads per path run one at a time; an event that arrives during one asks for one more after it.
  const reading = useRef(new Map<string, 'busy' | 'again'>());
  const lastRelist = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const candidates = useMemo(() => tracks.filter((track) => isLive(latestTs(track, fixes), now)), [tracks, fixes, now]);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const read = useCallback(async (path: string, fromTs: string) => {
    const state = reading.current.get(path);
    if (state) {
      reading.current.set(path, 'again');
      return;
    }
    reading.current.set(path, 'busy');
    try {
      const result = await execCommand<TrackRead>(`track-read ${shq(path)} --from=${fromTs} --still`);
      if (!mounted.current) return;
      const incoming = (result.segments ?? []).flatMap((segment) => segment.points);
      setFixes((current) => {
        const points = current.get(path) ?? [];
        const next = appendFixes(points, incoming);
        return next === points ? current : new Map(current).set(path, next);
      });
    } catch {
      // The next event or reconnect reads it again.
    } finally {
      const again = reading.current.get(path) === 'again';
      reading.current.delete(path);
      if (again && mounted.current) {
        const from = fixesRef.current.get(path)?.at(-1)?.ts ?? fromTs;
        read(path, from);
      }
    }
  }, []);

  // A track that becomes live is read from its last fix, which gives the point the live line starts
  // at; one that is no longer live is forgotten, so waking up again starts a new line.
  useEffect(() => {
    for (const track of candidates) {
      if (!fixes.has(track.path) && !reading.current.has(track.path) && track.lastTs) read(track.path, track.lastTs);
    }
    const stale = [...fixes.keys()].filter((path) => !candidates.some((track) => track.path === path));
    if (stale.length > 0) {
      setFixes((current) => {
        const next = new Map(current);
        for (const path of stale) next.delete(path);
        return next;
      });
    }
  }, [candidates, fixes, read]);

  useNodeEvents({ pathPrefix: CAMERAS_ROOT, nodeTypes: ['track'], eventTypes: ['updated'] }, (event) => {
    const track = candidatesRef.current.find((candidate) => candidate.path === event.path);
    const from = track && latestTs(track, fixesRef.current);
    if (from) {
      read(event.path, from);
      return;
    }
    if (Date.now() - lastRelist.current < RELIST_MS) return;
    lastRelist.current = Date.now();
    relist();
  });

  // Whatever was pushed while the socket was down was never seen.
  const epoch = shellClientEpoch.value;
  const firstEpoch = useRef(epoch);
  useEffect(() => {
    if (epoch === firstEpoch.current) return;
    for (const track of candidatesRef.current) {
      const known = fixesRef.current.get(track.path)?.at(-1)?.ts;
      if (known) read(track.path, known);
    }
  }, [epoch, read]);

  const anyLive = candidates.length > 0;
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [anyLive]);

  const live = useMemo(() =>
    candidates.flatMap((track): LiveTrack[] => {
      const points = fixes.get(track.path);
      const last = points?.at(-1);
      return points && last ? [{ track, points, last }] : [];
    }), [candidates, fixes]);

  return { live, now };
}
