import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import type { Merge } from '../lib/face-cut.ts';
import { shq } from '@ein/ui/lib';
import type { PersonFace } from './usePersonFaces.ts';
import type { PersonVoice } from './usePersonVoices.ts';
import type { SubclusterResult, VoiceSubclusterResult } from '@archive/media/api';

/** What can be re-clustered, and the item each kind clusters. */
type Kinds = { faces: PersonFace; voices: PersonVoice };
export type SubclusterKind = keyof Kinds;

type UseSubclustersResult<K extends SubclusterKind> = {
  /** The faces or voices, in the order the merges index them. */
  items: Kinds[K][];
  /** The agglomeration, ordered by decreasing similarity. Cut it with `../lib/face-cut.ts`. */
  merges: Merge[];
  /** Where the shape of the dendrogram says to cut — null while nothing is loaded. */
  suggested: number | null;
  /** Items with no embedding — box-only face tags, or voices never voiceprinted — which cannot be clustered. */
  withoutVector: number;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * The dendrogram over one person's own faces (`subcluster-faces`) or voices (`subcluster-voices`).
 *
 * Fetched once per person and then cut locally at whatever threshold the reviewer
 * lands on — the server does the quadratic work, the browser does the choosing.
 * A null path is the idle state and runs nothing, so a modal driven by this only
 * reads while it is open.
 */
export function useSubclusters<K extends SubclusterKind>(kind: K, personPath: string | null): UseSubclustersResult<K> {
  const [items, setItems] = useState<Kinds[K][]>([]);
  const [merges, setMerges] = useState<Merge[]>([]);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [withoutVector, setWithoutVector] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchSubclusters = useCallback(async () => {
    if (!personPath) {
      setItems([]);
      setMerges([]);
      setSuggested(null);
      setWithoutVector(0);
      setError(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await execCommand<SubclusterResult & VoiceSubclusterResult>(`subcluster-${kind} ${shq(personPath)}`);
      setItems((result[kind] ?? []) as Kinds[K][]);
      setMerges(result.merges ?? []);
      setSuggested(result.suggested?.threshold ?? null);
      setWithoutVector(result.withoutVector ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setItems([]);
      setMerges([]);
      setSuggested(null);
    } finally {
      setLoading(false);
    }
  }, [kind, personPath]);

  useEffect(() => {
    fetchSubclusters();
  }, [fetchSubclusters]);

  return { items, merges, suggested, withoutVector, loading, error, refetch: fetchSubclusters };
}
