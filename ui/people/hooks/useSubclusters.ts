import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import type { Merge } from '../lib/face-cut.ts';
import { shq } from '@ein/ui/lib';
import type { PersonFace } from './usePersonFaces.ts';
import type { SubclusterResult } from '@archive/media/api';

type UseSubclustersResult = {
  faces: PersonFace[];
  /** The agglomeration, ordered by decreasing similarity. Cut it with `../lib/face-cut.ts`. */
  merges: Merge[];
  /** Where the shape of the dendrogram says to cut — null while nothing is loaded. */
  suggested: number | null;
  /** Faces with no embedding — box-only tags, which cannot be clustered. */
  withoutVector: number;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * The dendrogram over one person's own faces.
 *
 * Fetched once per person and then cut locally at whatever threshold the reviewer
 * lands on — the server does the quadratic work, the browser does the choosing.
 * A null path is the idle state and runs nothing, so a modal driven by this only
 * reads while it is open.
 */
export function useSubclusters(personPath: string | null): UseSubclustersResult {
  const [faces, setFaces] = useState<PersonFace[]>([]);
  const [merges, setMerges] = useState<Merge[]>([]);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [withoutVector, setWithoutVector] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchSubclusters = useCallback(async () => {
    if (!personPath) {
      setFaces([]);
      setMerges([]);
      setSuggested(null);
      setWithoutVector(0);
      setError(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await execCommand<SubclusterResult>(`subcluster-faces ${shq(personPath)}`);
      setFaces(result.faces ?? []);
      setMerges(result.merges ?? []);
      setSuggested(result.suggested?.threshold ?? null);
      setWithoutVector(result.withoutVector ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setFaces([]);
      setMerges([]);
      setSuggested(null);
    } finally {
      setLoading(false);
    }
  }, [personPath]);

  useEffect(() => {
    fetchSubclusters();
  }, [fetchSubclusters]);

  return { faces, merges, suggested, withoutVector, loading, error, refetch: fetchSubclusters };
}
