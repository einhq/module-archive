import { useCallback, useEffect, useMemo, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { FamilyGraph, shq } from '@ein/ui/lib';
import type { FamilyDirection } from '@ein/ui/components';
import { collapseFamilyNodes, type FamilyExpansion, mergeFamilyNodes } from '../lib/family-graph.ts';
import type { FamilyNode, GraphResponse } from '@archive/people/api';

type UsePersonGraphResult = {
  graph: FamilyGraph | null;
  loading: boolean;
  error: Error | null;
  /** Pull in the generation above or below `path` and merge it in. */
  expand: (path: string, direction: FamilyDirection) => void;
  /** Take an expand back off: the people it brought in and everything grown from them. */
  collapse: (path: string, direction: FamilyDirection) => void;
  /** Paths each direction has been expanded from — a card offers to collapse those, not to expand them again. */
  expanded: Readonly<Record<FamilyDirection, ReadonlySet<string>>>;
  /** Currently fetching from this path that way, so its card can say so. */
  expanding: { path: string; direction: FamilyDirection } | null;
  /** Throw away every expansion and go back to the opening slice. */
  reset: () => void;
  /** Re-read everything, keeping the expansions — after an edit. */
  refetch: () => void;
};

type Held = { nodes: Record<string, FamilyNode>; expansions: FamilyExpansion[] };

const NOTHING: Held = { nodes: {}, expansions: [] };

/** What the opening view shows: enough to recognise the shape, little enough to read. */
const INITIAL_UP = 2;
const INITIAL_DOWN = 2;

/**
 * The family around one person, grown a generation at a time and folded back the same way.
 *
 * The whole graph is never fetched: a corpus reaching back to the 1600s would
 * arrive as a payload nobody can read and a drawing nobody can scan. Expanding a
 * card asks `person-graph` again rooted *there*, one generation the way it was
 * expanded, and merges the answer, so the command stays stateless and each
 * click costs one exec. Each expand remembers who it brought in, which is what
 * collapsing it takes off again.
 *
 * Slices accumulate through `mergeFamilyNodes`, which unions the edges rather
 * than replacing them — see there for why replacing detaches rows that are
 * already on screen.
 */
export function usePersonGraph(rootPath: string | null): UsePersonGraphResult {
  const [held, setHeld] = useState<Held>(NOTHING);
  const [expanding, setExpanding] = useState<{ path: string; direction: FamilyDirection } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!rootPath) {
      setHeld(NOTHING);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const answer = await execCommand<GraphResponse>(`person-graph ${shq(rootPath)} --up ${INITIAL_UP} --down ${INITIAL_DOWN}`);
        if (cancelled) return;
        setHeld({ nodes: answer.nodes ?? {}, expansions: [] });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setHeld(NOTHING);
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
      const incoming = answer.nodes ?? {};
      setHeld((current) => ({
        nodes: mergeFamilyNodes(current.nodes, incoming),
        expansions: [...current.expansions, { path, direction, added: Object.keys(incoming).filter((key) => !current.nodes[key]) }],
      }));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setExpanding(null);
    }
  }, []);

  const collapse = useCallback((path: string, direction: FamilyDirection) => {
    if (!rootPath) return;
    setHeld((current) => collapseFamilyNodes(rootPath, current.nodes, current.expansions, path, direction));
  }, [rootPath]);

  const reset = useCallback(() => setReloadKey((key) => key + 1), []);

  const expanded = useMemo(() => ({
    up: new Set(held.expansions.filter((expansion) => expansion.direction === 'up').map((expansion) => expansion.path)),
    down: new Set(held.expansions.filter((expansion) => expansion.direction === 'down').map((expansion) => expansion.path)),
  }), [held.expansions]);

  // `person-graph`'s nodes handed to the kit's tree as its own `FamilyGraph`: the two shapes are
  // kept apart on purpose, and this assignment is what checks they still agree.
  const nodes = held.nodes;
  const graph = useMemo(() => (rootPath && nodes[rootPath] ? { root: rootPath, nodes } : null), [rootPath, nodes]);

  return {
    graph,
    loading,
    error,
    expand: useCallback((path: string, direction: FamilyDirection) => void expand(path, direction), [expand]),
    collapse,
    expanded,
    expanding,
    reset,
    refetch: reset,
  };
}
