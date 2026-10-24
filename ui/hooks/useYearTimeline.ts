import { useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { TimelineEntry, TimelineKind } from '@archive/timeline/api';
import type { TimelineFilters, TimelinePage } from '../lib/timeline-entries.ts';

/** The command's own ceiling; a year is read in as few round trips as it allows. */
const PAGE_SIZE = 200;

function buildYearTimelineCommand(year: number, kinds: readonly TimelineKind[], filters: TimelineFilters, cursor?: string): string {
  const parts = ['timeline', '--year', String(year), '-l', String(PAGE_SIZE)];
  if (kinds.length) parts.push('--kind', kinds.join(','));
  if (filters.query) parts.push('--q', shq(filters.query));
  if (filters.person) parts.push('--person', shq(filters.person));
  if (filters.location) parts.push('--location', shq(filters.location));
  if (filters.tag) parts.push('--tag', shq(filters.tag));
  if (cursor) parts.push('--cursor', shq(cursor));
  return parts.join(' ');
}

type UseYearTimelineResult = {
  entries: TimelineEntry[];
  loading: boolean;
  error: Error | null;
};

/**
 * Everything the `timeline` command has for one year, newest first; the caller sorts.
 *
 * A year is read whole rather than paged on scroll: a year's albums fit in a page or
 * two of the command, and a finite list is what lets the page say how many there are.
 *
 * `year` changes quickly while someone drags the picker, so each fetch carries a
 * generation and an answer for a year already left behind is dropped rather than
 * flashed.
 */
export function useYearTimeline(year: number, kinds: readonly TimelineKind[], filters: TimelineFilters = {}): UseYearTimelineResult {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const generationRef = useRef(0);

  // Callers pass fresh arrays and objects every render; compare by value.
  const kindKey = kinds.join(',');
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    const generation = ++generationRef.current;
    const stale = () => generation !== generationRef.current;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const collected: TimelineEntry[] = [];
        let cursor: string | null = null;
        do {
          const command = buildYearTimelineCommand(year, kindKey ? kindKey.split(',') as TimelineKind[] : [], JSON.parse(filterKey), cursor ?? undefined);
          const page: TimelinePage = await execCommand<TimelinePage>(command);
          if (stale()) return;
          collected.push(...page.entries);
          cursor = page.cursor;
        } while (cursor !== null);

        setEntries(collected);
      } catch (err) {
        if (stale()) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setEntries([]);
      } finally {
        if (!stale()) setLoading(false);
      }
    })();
  }, [year, kindKey, filterKey]);

  return { entries, loading, error };
}
