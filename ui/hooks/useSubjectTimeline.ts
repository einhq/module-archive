import { useCallback, useEffect, useMemo, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { TimelineEntry, TimelineGroup } from '../lib/timeline-entries.ts';

/**
 * A command that answers with one subject's history as feed entries — people's
 * `person-timeline` and `location-timeline`, device's `device-timeline` — taking the subject's
 * path and `--no-albums`. The hook reads only `entries`, so it names no module's answer type.
 */
type SubjectTimelineCommand = string;

type SubjectTimeline = { entries: TimelineEntry[] };

type UseSubjectTimelineResult = {
  entries: TimelineEntry[];
  /** The entries under year headers, newest year first. */
  groups: TimelineGroup[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * One subject's history as a feed: a person's life (births, deaths, events,
 * moves, partnerships, their children's births), a location's residents coming and
 * going, a device's owners — and, for each, the albums they appear in.
 *
 * Unpaged, unlike the global timeline — a subject has tens to low hundreds of
 * entries, so there is no cursor, no anchor and no scrubber. The entries are the
 * same shape the global feed uses, so `TimelineEntryCard` draws them unchanged.
 *
 * Fetched in two passes, because the two halves cost wildly different amounts.
 * Everything but the albums is a handful of round trips. The albums mean
 * materializing the subject's whole media set and reading a cover for each one,
 * which takes seconds for a well-photographed person. Asking twice costs one
 * cheap extra exec and lets the page draw the quick half immediately and grow.
 */
export function useSubjectTimeline(command: SubjectTimelineCommand, path: string | null): UseSubjectTimelineResult {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!path) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);

        const quick = await execCommand<SubjectTimeline>(`${command} ${shq(path)} --no-albums`);
        if (cancelled) return;
        setEntries(quick.entries ?? []);

        // The full answer supersedes the first rather than being merged into it:
        // it contains everything the first did, and recomputing the cheap half
        // costs less than reconciling two lists by key.
        const full = await execCommand<SubjectTimeline>(`${command} ${shq(path)}`);
        if (cancelled) return;
        setEntries(full.entries ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [command, path, reloadKey]);

  // Years, not months: a history spans decades, and a month header above a
  // single birthday is a header per entry.
  const groups = useMemo(() => {
    const buckets: TimelineGroup[] = [];
    let current: TimelineGroup | undefined;

    for (const entry of entries) {
      const key = entry.date.slice(0, 4);
      if (!current || current.key !== key) {
        current = { key, label: key, entries: [] };
        buckets.push(current);
      }
      current.entries.push(entry);
    }

    return buckets;
  }, [entries]);

  return { entries, groups, loading, error, refetch: useCallback(() => setReloadKey((key) => key + 1), []) };
}
