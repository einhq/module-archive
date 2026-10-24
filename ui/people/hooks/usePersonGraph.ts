import { useCallback, useEffect, useMemo, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { FamilyGraph, shq } from '@ein/ui/lib';
import { mergeFamilyNodes } from '../lib/family-graph.ts';
import type { FamilyNode, GraphResponse } from '@archive/people/api';

type UsePersonGraphResult = {
  graph: FamilyGraph | null;
  loading: boolean;
  error: Error | null;
  /** Pull in one more generation each way around `path` and merge it in. */
  expand: (path: string) => void;
  /** Paths whose neighbours have been fetched — a card only offers to expand once. */
  expanded: ReadonlySet<string>;
  /** Currently fetching around this path, so the card can say so. */
  expanding: string | null;
  /** Throw away every expansion and go back to the opening slice. */
  reset: () => void;
  /** Re-read everything, keeping the expansions — after an edit. */
  refetch: () => void;
};

/** What the opening view shows: enough to recognise the shape, little enough to read. */
const INITIAL_UP = 2;
const INITIAL_DOWN = 2;

/**
 * The family around one person, grown a generation at a time.
 *
 * The whole graph is never fetched: a corpus reaching back to the 1600s would
 * arrive as a payload nobody can read and a drawing nobody can scan. Expanding a
 * card asks `person-graph` again rooted *there* and merges the answer, so the
 * command stays stateless and each click costs one exec.
 *
 * Slices accumulate through `mergeFamilyNodes`, which unions the edges rather
 * than replacing them — see there for why replacing detaches rows that are
 * already on screen.
 */
export function usePersonGraph(rootPath: string | null): UsePersonGraphResult {
  const [nodes, setNodes] = useState<Record<string, FamilyNode>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [expanding, setExpanding] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!rootPath) {
      setNodes({});
      setExpanded(new Set());
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
        setExpanded(new Set());
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

  const expand = useCallback(async (path: string) => {
    setExpanding(path);
    try {
      const answer = await execCommand<GraphResponse>(`person-graph ${shq(path)} --up 1 --down 1`);
      setNodes((current) => mergeFamilyNodes(current, answer.nodes ?? {}));
      setExpanded((current) => new Set(current).add(path));
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
    expand: useCallback((path: string) => void expand(path), [expand]),
    expanded,
    expanding,
    reset,
    refetch: reset,
  };
}
