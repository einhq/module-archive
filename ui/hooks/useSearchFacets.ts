import { useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import type { SearchKind } from '@ein/ui/hooks';

type YearBucket = { year: number; count: number };
type KindBucket = { kind: string; count: number };

type SearchFacets = {
  total: number;
  range: { min: number; max: number } | null;
  years: YearBucket[];
  kinds: KindBucket[];
};

type FacetsResponse = SearchFacets;

/**
 * Year and kind histograms for sizing the search filters.
 *
 * Deliberately keyed on kind only, never on the year range itself: the slider
 * reads its own bounds from here, so refetching per slider tick would make the
 * control's bounds move underneath the user while dragging.
 */
export function useSearchFacets(kinds: SearchKind[] | undefined): {
  facets: SearchFacets | null;
  loading: boolean;
  error: Error | null;
} {
  const [facets, setFacets] = useState<SearchFacets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const generationRef = useRef(0);

  const kindKey = (kinds ?? []).join(',');

  useEffect(() => {
    const generation = ++generationRef.current;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const cmd = kindKey ? `facets --kind ${kindKey}` : 'facets';
        const resp = await execCommand<FacetsResponse>(cmd);
        if (generation !== generationRef.current) return;

        setFacets({
          total: resp.total ?? 0,
          range: resp.range ?? null,
          years: resp.years ?? [],
          kinds: resp.kinds ?? [],
        });
      } catch (err) {
        if (generation !== generationRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setFacets(null);
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    })();
  }, [kindKey]);

  return { facets, loading, error };
}
