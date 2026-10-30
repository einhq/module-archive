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

/** One expand of a card: which way, and the people it brought onto the tree that were not there before. */
export type FamilyExpansion = { path: string; direction: 'up' | 'down'; added: string[] };

/**
 * Undo an expand: take off the people it brought in, the people every later expand from one of them
 * brought in, and anybody left with no tie to `root`, and trim every edge to them. People who were
 * on the tree before it stay, however they are related.
 *
 * Another expand whose relatives that way are now no longer all drawn is forgotten too, so its card
 * offers to expand again rather than claiming a branch it no longer shows.
 */
export function collapseFamilyNodes(
  root: string,
  nodes: Record<string, FamilyNode>,
  expansions: readonly FamilyExpansion[],
  path: string,
  direction: 'up' | 'down',
): { nodes: Record<string, FamilyNode>; expansions: FamilyExpansion[] } {
  const undone = expansions.find((expansion) => expansion.path === path && expansion.direction === direction);
  if (!undone) return { nodes, expansions: [...expansions] };

  const removed = new Set<string>();
  const dropped = new Set<FamilyExpansion>();
  const pending = [undone];
  while (pending.length > 0) {
    const expansion = pending.pop()!;
    if (dropped.has(expansion)) continue;
    dropped.add(expansion);
    for (const added of expansion.added) {
      if (added !== root) removed.add(added);
    }
    pending.push(...expansions.filter((other) => !dropped.has(other) && removed.has(other.path)));
  }

  // Whoever is left with no way back to the root went with them.
  const reached = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const node = nodes[queue.pop()!];
    if (!node) continue;
    for (const next of [...node.parents, ...node.children, ...node.partners.map((partner) => partner.path)]) {
      if (removed.has(next) || reached.has(next) || !nodes[next]) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  const kept: Record<string, FamilyNode> = {};
  for (const [key, node] of Object.entries(nodes)) {
    if (!reached.has(key)) continue;
    kept[key] = {
      ...node,
      parents: node.parents.filter((other) => reached.has(other)),
      children: node.children.filter((other) => reached.has(other)),
      partners: node.partners.filter((partner) => reached.has(partner.path)),
    };
  }

  const whole = (expansion: FamilyExpansion): boolean => {
    const before = nodes[expansion.path];
    const after = kept[expansion.path];
    if (!before || !after) return false;
    return expansion.direction === 'up' ? after.parents.length === before.parents.length : after.children.length === before.children.length;
  };

  return { nodes: kept, expansions: expansions.filter((expansion) => !dropped.has(expansion) && whole(expansion)) };
}

/**
 * Rebuild a tree from a fresh opening slice and the expands made on it, in the order they were made:
 * `slices[i]` is the fresh answer for `expansions[i]`. An expand whose card is no longer on the tree
 * (an edit took the person off it) is dropped, and each kept one records who it brings in now.
 */
export function replayFamilyExpansions(
  base: Record<string, FamilyNode>,
  expansions: readonly FamilyExpansion[],
  slices: readonly Record<string, FamilyNode>[],
): { nodes: Record<string, FamilyNode>; expansions: FamilyExpansion[] } {
  let nodes = base;
  const kept: FamilyExpansion[] = [];
  expansions.forEach((expansion, index) => {
    if (!nodes[expansion.path]) return;
    const incoming = slices[index];
    kept.push({ ...expansion, added: Object.keys(incoming).filter((key) => !nodes[key]) });
    nodes = mergeFamilyNodes(nodes, incoming);
  });
  return { nodes, expansions: kept };
}
