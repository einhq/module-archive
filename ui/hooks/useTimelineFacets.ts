import { useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { RecurrenceMode, TimelineKind } from '@archive/timeline/api';
import type { TimelineFilters } from '../lib/timeline-entries.ts';

type TimelineMonthBucket = { key: string; count: number };
type TimelineYearBucket = { year: number; count: number };

type TimelineFacets = {
  total: number;
  range: { min: number; max: number } | null;
  days: TimelineMonthBucket[];
  months: TimelineMonthBucket[];
  years: TimelineYearBucket[];
  kinds: { kind: string; count: number }[];
  /**
   * A filtered rail is sized by walking the feed rather than aggregating it, and
   * the walk is bounded — past that, `total` is a floor rather than a count.
   */
  truncated: boolean;
};

/**
 * Per-month and per-year counts, for sizing the scrubber.
 *
 * Keyed on the filters but never on the scroll position or the anchor: the rail
 * draws its own geometry from these numbers, so refetching as the feed moves
 * would make the rail resize under the finger dragging it.
 */
export function useTimelineFacets(
  kinds: readonly TimelineKind[] | undefined,
  recurrence: RecurrenceMode | undefined,
  filters?: TimelineFilters,
): {
  facets: TimelineFacets | null;
  loading: boolean;
  error: Error | null;
} {
  const [facets, setFacets] = useState<TimelineFacets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const generationRef = useRef(0);

  const kindKey = (kinds ?? []).join(',');
  // Filters arrive as a fresh object every render; compare by value.
  const filterKey = JSON.stringify(filters ?? {});

  useEffect(() => {
    const generation = ++generationRef.current;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const active: TimelineFilters = JSON.parse(filterKey);
        const parts = ['timeline-facets'];
        if (kindKey) parts.push('--kind', kindKey);
        if (recurrence) parts.push('--birthdays', recurrence, '--anniversaries', recurrence);
        if (active.query) parts.push('--q', shq(active.query));
        if (active.person) parts.push('--person', shq(active.person));
        if (active.location) parts.push('--location', shq(active.location));
        if (active.tag) parts.push('--tag', shq(active.tag));

        const resp = await execCommand<TimelineFacets>(parts.join(' '));
        if (generation !== generationRef.current) return;

        setFacets({
          total: resp.total ?? 0,
          range: resp.range ?? null,
          days: resp.days ?? [],
          months: resp.months ?? [],
          years: resp.years ?? [],
          kinds: resp.kinds ?? [],
          truncated: resp.truncated ?? false,
        });
      } catch (err) {
        if (generation !== generationRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setFacets(null);
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    })();
  }, [kindKey, recurrence, filterKey]);

  return { facets, loading, error };
}
