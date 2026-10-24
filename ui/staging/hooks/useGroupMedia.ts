import { loadMediaSet, type MediaSet, peekMediaSet } from '@ein/ui/lib';
import { useEffect, useState } from 'react';

/**
 * The pictures of one suggested album, from the kit's media sets: at once when they are kept,
 * fetched once `wanted` (the section has settled in view, or is open). `memberKey` names the
 * members they are of; when it changes, they are asked for again. A fetch the section no longer
 * wants, because it left, is given up.
 */
export function useGroupMedia(path: string, memberKey: string, wanted: boolean): { set: MediaSet | null; error: Error | null; retry: () => void } {
  const key = `${path}\n${memberKey}`;
  const [state, setState] = useState<{ key: string; set: MediaSet | null; error: Error | null }>(() => ({ key, set: peekMediaSet(path) ?? null, error: null }));
  const [attempt, setAttempt] = useState(0);
  const current = state.key === key ? state : { key, set: peekMediaSet(path) ?? null, error: null };

  useEffect(() => {
    if (!wanted || current.set) return;
    const controller = new AbortController();
    loadMediaSet(path, { signal: controller.signal })
      .then((set) => setState({ key, set, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setState({ key, set: null, error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => controller.abort();
  }, [key, wanted, attempt, current.set === null]);

  const retry = () => {
    setState({ key, set: null, error: null });
    setAttempt((value) => value + 1);
  };
  return { set: current.set, error: current.error, retry };
}
