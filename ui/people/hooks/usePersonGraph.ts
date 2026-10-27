import { useCallback, useEffect, useMemo, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { FamilyGraph, shq } from '@ein/ui/lib';
import type { FamilyDirection } from '@ein/ui/components';
import { mergeFamilyNodes } from '../lib/family-graph.ts';
import type { FamilyNode, GraphResponse } from '@archive/people/api';

type UsePersonGraphResult = {
  graph: FamilyGraph | null;
  loading: boolean;
  error: Error | null;
  /** Pull in the generation above or below `path` and merge it in. */
  expand: (path: string, direction: FamilyDirection) => void;
  /** Paths each direction has been fetched from — a card only offers to expand that way once. */
  expanded: Readonly<Record<FamilyDirection, ReadonlySet<string>>>;
  /** Currently fetching from this path that way, so its card can say so. */
  expanding: { path: string; direction: FamilyDirection } | null;
  /** Throw away every expansion and go back to the opening slice. */
  reset: () => void;
  /** Re-read everything, keeping the expansions — after an edit. */
  refetch: () => void;
};

const NONE_EXPANDED = { up: new Set<string>(), down: new Set<string>() } as const;

/** What the opening view shows: enough to recognise the shape, little enough to read. */
const INITIAL_UP = 2;
const INITIAL_DOWN = 2;

/**
 * The family around one person, grown a generation at a time.
 *
 * The whole graph is never fetched: a corpus reaching back to the 1600s would
 * arrive as a payload nobody can read and a drawing nobody can scan. Expanding a
 * card asks `person-graph` again rooted *there*, one generation the way it was
 * expanded, and merges the answer, so the command stays stateless and each
 * click costs one exec.
 *
 * Slices accumulate through `mergeFamilyNodes`, which unions the edges rather
 * than replacing them — see there for why replacing detaches rows that are
 * already on screen.
 */
export function usePersonGraph(rootPath: string | null): UsePersonGraphResult {
  const [nodes, setNodes] = useState<Record<string, FamilyNode>>({});
  const [expanded, setExpanded] = useState<Readonly<Record<FamilyDirection, ReadonlySet<string>>>>(NONE_EXPANDED);
  const [expanding, setExpanding] = useState<{ path: string; direction: FamilyDirection } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!rootPath) {
      setNodes({});
      setExpanded(NONE_EXPANDED);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const answer = await execCommand<GraphResponse>(`person-graph ${shq(rootPath)} --up ${INITIAL_UP} --down ${INITIAL_DOWN}`);
        if (cancelled) return;
        setNodes(answer.nodes ?? {});
        setExpanded(NONE_EXPANDED);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setNodes({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadKey]);

  const expand = useCallback(async (path: string, direction: FamilyDirection) => {
    setExpanding({ path, direction });
    try {
      const [up, down] = direction === 'up' ? [1, 0] : [0, 1];
      const answer = await execCommand<GraphResponse>(`person-graph ${shq(path)} --up ${up} --down ${down}`);
      setNodes((current) => mergeFamilyNodes(current, answer.nodes ?? {}));
      setExpanded((current) => ({ ...current, [direction]: new Set(current[direction]).add(path) }));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setExpanding(null);
    }
  }, []);

  const reset = useCallback(() => setReloadKey((key) => key + 1), []);

  // `person-graph`'s nodes handed to the kit's tree as its own `FamilyGraph`: the two shapes are
  // kept apart on purpose, and this assignment is what checks they still agree.
  const graph = useMemo(() => (rootPath && nodes[rootPath] ? { root: rootPath, nodes } : null), [rootPath, nodes]);

  return {
    graph,
    loading,
    error,
    expand: useCallback((path: string, direction: FamilyDirection) => void expand(path, direction), [expand]),
    expanded,
    expanding,
    reset,
    refetch: reset,
  };
}
