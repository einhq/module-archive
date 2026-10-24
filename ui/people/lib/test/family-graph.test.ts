/**
 * Folding one slice of the family graph into another.
 *
 * The case that matters is the one that is easy to get wrong: a person seen in
 * two slices carries a different edge list in each, and taking the newer one
 * wholesale silently detaches whatever the newer slice could not see.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { mergeFamilyNodes } from '../family-graph.ts';
import type { FamilyNode } from '@archive/people/api';

const node = (name: string, over: Partial<FamilyNode> = {}): FamilyNode => ({
  path: `${PEOPLE_ROOT}/${name}`,
  name,
  parents: [],
  children: [],
  partners: [],
  parentCount: 0,
  childCount: 0,
  ...over,
});

Deno.test('family graph merge: a thinner later slice does not drop known edges', () => {
  // What is on screen: anna, with her two children drawn below her.
  const held = {
    [`${PEOPLE_ROOT}/anna`]: node('anna', { children: [`${PEOPLE_ROOT}/mia`, `${PEOPLE_ROOT}/edvin`], childCount: 2, parentCount: 2 }),
  };

  // Expanding her mother answers with anna again — but from up there, her
  // children are two rows out of the slice and come back empty.
  const fromGrandmother = {
    [`${PEOPLE_ROOT}/eva`]: node('eva', { children: [`${PEOPLE_ROOT}/anna`], childCount: 1 }),
    [`${PEOPLE_ROOT}/anna`]: node('anna', { parents: [`${PEOPLE_ROOT}/eva`], childCount: 2, parentCount: 2 }),
  };

  const merged = mergeFamilyNodes(held, fromGrandmother);

  assertEquals(merged[`${PEOPLE_ROOT}/anna`].children.toSorted(), [`${PEOPLE_ROOT}/edvin`, `${PEOPLE_ROOT}/mia`]);
  assertEquals(merged[`${PEOPLE_ROOT}/anna`].parents, [`${PEOPLE_ROOT}/eva`]);
  assertEquals(merged[`${PEOPLE_ROOT}/eva`].children, [`${PEOPLE_ROOT}/anna`]);
});

Deno.test('family graph merge: scalars come from the newer answer', () => {
  const held = { [`${PEOPLE_ROOT}/anna`]: node('anna', { name: 'anna', childCount: 1 }) };
  const fresh = { [`${PEOPLE_ROOT}/anna`]: node('anna', { name: 'Anna Berg', born: '1950', childCount: 4 }) };

  const merged = mergeFamilyNodes(held, fresh);
  assertEquals(merged[`${PEOPLE_ROOT}/anna`].name, 'Anna Berg');
  assertEquals(merged[`${PEOPLE_ROOT}/anna`].born, '1950');
  // The counts are absolute totals the server computed either way, so the newer
  // one is simply the current one.
  assertEquals(merged[`${PEOPLE_ROOT}/anna`].childCount, 4);
});

Deno.test('family graph merge: partners union by path, without duplicating', () => {
  const held = { [`${PEOPLE_ROOT}/anna`]: node('anna', { partners: [{ path: `${PEOPLE_ROOT}/erik`, kind: 'married' }] }) };
  const fresh = {
    [`${PEOPLE_ROOT}/anna`]: node('anna', { partners: [{ path: `${PEOPLE_ROOT}/erik` }, { path: `${PEOPLE_ROOT}/lars` }] }),
  };

  const merged = mergeFamilyNodes(held, fresh);
  assertEquals(merged[`${PEOPLE_ROOT}/anna`].partners.map((p) => p.path), [`${PEOPLE_ROOT}/erik`, `${PEOPLE_ROOT}/lars`]);
  // The one already held keeps what it knew; a second copy of the same tie is
  // not a second partner.
  assertEquals(merged[`${PEOPLE_ROOT}/anna`].partners[0].kind, 'married');
});

Deno.test('family graph merge: people only in one side survive', () => {
  const merged = mergeFamilyNodes({ [`${PEOPLE_ROOT}/a`]: node('a') }, { [`${PEOPLE_ROOT}/b`]: node('b') });
  assertEquals(Object.keys(merged).toSorted(), [`${PEOPLE_ROOT}/a`, `${PEOPLE_ROOT}/b`]);
});
