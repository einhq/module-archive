/**
 * Accumulating a family graph out of the slices `person-graph` answers with.
 *
 * Pure, and separate from the drawing, because the merge rule is subtle enough
 * to be worth asserting on its own: it is where the tree quietly loses rows if
 * it is got wrong.
 */

import type { FamilyNode } from '@archive/people/api';

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

/**
 * Fold a fresh slice into what is already held, keeping the **union** of the
 * edges.
 *
 * The command only names edges it has both ends for, so the same person comes
 * back with a different edge list depending on which slice they appeared in:
 * asking around a grandmother returns her daughter with no children at all,
 * because the grandchildren are two rows below that slice and not in it.
 * Last-writer-wins would take the emptier record and detach rows already on
 * screen.
 *
 * The scalar facts — name, dates, and the counts, which are absolute totals the
 * server computed the same way either time — come from the newer answer. Only
 * the edge lists accumulate, because those are the ones that shrink with the
 * slice they were observed in. Every edge end ever reported is a person still
 * being held, so the union can never name somebody who is not there.
 */
export function mergeFamilyNodes(current: Record<string, FamilyNode>, incoming: Record<string, FamilyNode>): Record<string, FamilyNode> {
  const merged = { ...current };

  for (const [path, node] of Object.entries(incoming)) {
    const held = merged[path];
    merged[path] = held
      ? {
        ...node,
        parents: union(held.parents, node.parents),
        children: union(held.children, node.children),
        partners: [...held.partners, ...node.partners.filter((fresh) => !held.partners.some((known) => known.path === fresh.path))],
      }
      : node;
  }

  return merged;
}
