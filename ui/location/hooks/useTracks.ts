import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoBounds, MapTrackSpec } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { dayColor } from '../lib/track-colors.ts';
import { execCommand } from '@ein/ui/signals';
import type { TrackEntry, TrackRead } from '@archive/location/api';

/**
 * Every device's track with its summary (`track-list`), which the track
 * registry answers for all of them at once, so a listing never opens a track.
 */
function useTracks(): { tracks: TrackEntry[]; loading: boolean; error: Error | null; refetch: () => void } {
  const [tracks, setTracks] = useState<TrackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchTracks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setTracks(await execCommand<TrackEntry[]>('track-list'));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  return { tracks, loading, error, refetch: fetchTracks };
}

/** A track read, as one colored line per day, labelled by `label`. */
const toSpecs = (path: string, read: TrackRead, label: (day: string) => string): MapTrackSpec[] =>
  (read.segments ?? []).map((segment, index): MapTrackSpec => ({
    id: `${path}|${segment.day}|${index}`,
    points: segment.points,
    color: dayColor(path, segment.day),
    label: label(segment.day),
  }));

/**
 * One device's whole track, thinned to about `maxPoints`. `id` is the device's slug.
 *
 * The cap goes to the server, which simplifies and cuts the line there — a
 * dense day is never shipped whole just to be thrown away in the browser.
 */
export function useTrack(
  id: string | undefined,
  maxPoints = 4000,
): { track: TrackEntry | undefined; segments: MapTrackSpec[]; truncated: boolean; loading: boolean; error: Error | null; refetch: () => void } {
  const { tracks, loading: listLoading, error: listError, refetch } = useTracks();
  const [segments, setSegments] = useState<MapTrackSpec[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const track = tracks.find((entry) => entry.id === id);
  const path = track?.path;
  const points = track?.points ?? 0;

  useEffect(() => {
    if (!path) {
      setSegments([]);
      setLoading(listLoading);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await execCommand<TrackRead>(`track-read ${shq(path)} --limit=${maxPoints}`);
        if (cancelled) return;

        setTruncated(result.truncated === true);
        setSegments(toSpecs(path, result, (day) => day));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setSegments([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, points, maxPoints, listLoading]);

  return { track, segments, truncated, loading: loading || listLoading, error: error ?? listError, refetch };
}

/** Two boxes that share no area at all. A track outside the view is never read. */
const overlaps = (a: GeoBounds, b: GeoBounds): boolean => a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;

/**
 * How much detail to ask for at this zoom, as a simplification tolerance in
 * degrees.
 *
 * Screen space is what limits how much detail can be seen: zoomed out, a day of
 * one-second fixes is thousands of points inside a few pixels. One tile is 256px
 * across at zoom 0, so a pixel is `360 / (256 * 2**zoom)` degrees wide; asking
 * for about a pixel and a half of tolerance drops what could not be drawn
 * apart anyway, and the server never sends it.
 */
const toleranceForZoom = (zoom: number): number => (360 / (256 * 2 ** zoom)) * 1.5;

/** Per-track point cap, so one pathological track cannot stall the map. */
const POINT_LIMIT = 5000;

/**
 * Track geometry for a map viewport, split per day and colored.
 *
 * Debounced, and guarded by a generation — a pan fires `moveend` repeatedly and
 * only the last one is worth reading for.
 */
export function useMapTracks(enabled: boolean): { segments: MapTrackSpec[]; loading: boolean; query: (bounds: GeoBounds, zoom: number) => void } {
  const { tracks } = useTracks();
  const [segments, setSegments] = useState<MapTrackSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const lastQueryRef = useRef<{ bounds: GeoBounds; zoom: number } | null>(null);

  const run = useCallback((bounds: GeoBounds, zoom: number, available: TrackEntry[]) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      const generation = ++generationRef.current;
      const box = { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west };
      // A track with no bbox has never been summarised; read it rather than hide it.
      const candidates = available.filter((track) => !track.bbox || overlaps(track.bbox, box));

      if (candidates.length === 0) {
        setSegments([]);
        return;
      }

      try {
        setLoading(true);
        const tolerance = toleranceForZoom(zoom);
        const bbox = `${box.north},${box.south},${box.east},${box.west}`;

        const reads = await Promise.all(candidates.map(async (track) => {
          const result = await execCommand<TrackRead>(
            `track-read ${shq(track.path)} --bbox=${bbox} --tolerance=${tolerance} --limit=${POINT_LIMIT}`,
          ).catch((): TrackRead => ({ segments: [], points: 0, truncated: false }));
          return { track, read: result };
        }));

        if (generation !== generationRef.current) return;

        setSegments(reads.flatMap(({ track, read }) => toSpecs(track.path, read, (day) => `${track.name} · ${day}`)));
      } catch {
        if (generation === generationRef.current) setSegments([]);
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    }, 300) as unknown as number;
  }, []);

  const query = useCallback((bounds: GeoBounds, zoom: number) => {
    lastQueryRef.current = { bounds, zoom };
    if (!enabled) return;
    run(bounds, zoom, tracks);
  }, [enabled, run, tracks]);

  // The layer being switched on, or the track list arriving, has to redraw the
  // viewport the map is already showing — neither of them moves the map.
  useEffect(() => {
    if (!enabled) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      generationRef.current++;
      setSegments([]);
      setLoading(false);
      return;
    }
    const last = lastQueryRef.current;
    if (last) run(last.bounds, last.zoom, tracks);
  }, [enabled, tracks, run]);

  return { segments, loading, query };
}

/**
 * The devices' routes over a span of time — what an album shows: every track that
 * recorded anything between `from` and `to`, read for that span alone.
 */
export function useSpanTracks(from: string | undefined, to: string | undefined, maxPoints = 4000): { segments: MapTrackSpec[]; loading: boolean } {
  const { tracks, loading: listLoading } = useTracks();
  const [segments, setSegments] = useState<MapTrackSpec[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Whole days, in this browser's time: the route goes on before the first capture and after the
    // last. Compared as instants, since a span's ends may be written with or without a zone.
    const start = from ? Date.parse(`${from.slice(0, 10)}T00:00:00`) : NaN;
    const end = to ? Date.parse(`${to.slice(0, 10)}T23:59:59.999`) : NaN;
    const during = Number.isNaN(start) || Number.isNaN(end)
      ? []
      : tracks.filter((track) => track.firstTs && track.lastTs && Date.parse(track.firstTs) <= end && Date.parse(track.lastTs) >= start);
    if (during.length === 0) {
      setSegments([]);
      return;
    }
    let cancelled = false;
    const window = `--from=${new Date(start).toISOString()} --to=${new Date(end).toISOString()}`;

    (async () => {
      setLoading(true);
      const reads = await Promise.all(during.map(async (track) => ({
        track,
        read: await execCommand<TrackRead>(`track-read ${shq(track.path)} ${window} --limit=${maxPoints}`)
          .catch((): TrackRead => ({ segments: [], points: 0, truncated: false })),
      })));
      if (cancelled) return;
      setSegments(reads.flatMap(({ track, read }) => toSpecs(track.path, read, (day) => `${track.name} · ${day}`)));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tracks, from, to, maxPoints]);

  return { segments, loading: loading || listLoading };
}
