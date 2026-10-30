/**
 * Folding one slice of the family graph into another.
 *
 * The case that matters is the one that is easy to get wrong: a person seen in
 * two slices carries a different edge list in each, and taking the newer one
 * wholesale silently detaches whatever the newer slice could not see.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { collapseFamilyNodes, mergeFamilyNodes, replayFamilyExpansions } from '../family-graph.ts';
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

Deno.test('family graph collapse: an expand is undone with everything grown from it', () => {
  const p = (name: string) => `${PEOPLE_ROOT}/${name}`;
  // mia on screen with her mother anna; anna expanded up brought gustav and
  // hedda, and gustav expanded down then brought nils.
  const nodes = {
    [p('mia')]: node('mia', { parents: [p('anna')], parentCount: 1 }),
    [p('anna')]: node('anna', { children: [p('mia')], parents: [p('gustav'), p('hedda')], parentCount: 2, childCount: 1 }),
    [p('gustav')]: node('gustav', { children: [p('anna'), p('nils')], partners: [{ path: p('hedda') }], childCount: 2 }),
    [p('hedda')]: node('hedda', { children: [p('anna'), p('nils')], partners: [{ path: p('gustav') }], childCount: 2 }),
    [p('nils')]: node('nils', { parents: [p('gustav'), p('hedda')], parentCount: 2 }),
  };
  const expansions = [
    { path: p('anna'), direction: 'up' as const, added: [p('gustav'), p('hedda')] },
    { path: p('gustav'), direction: 'down' as const, added: [p('nils')] },
  ];

  const folded = collapseFamilyNodes(p('mia'), nodes, expansions, p('anna'), 'up');
  assertEquals(Object.keys(folded.nodes).sort(), [p('anna'), p('mia')]);
  // Anna's parents are off the tree, and the count still says she has two.
  assertEquals(folded.nodes[p('anna')].parents, []);
  assertEquals(folded.nodes[p('anna')].parentCount, 2);
  assertEquals(folded.expansions, []);

  // Undoing only the later expand keeps the earlier one.
  const once = collapseFamilyNodes(p('mia'), nodes, expansions, p('gustav'), 'down');
  assertEquals(Object.keys(once.nodes).sort(), [p('anna'), p('gustav'), p('hedda'), p('mia')]);
  assertEquals(once.nodes[p('hedda')].children, [p('anna')]);
  assertEquals(once.expansions, [expansions[0]]);
});

Deno.test('family graph collapse: another expand left incomplete is forgotten', () => {
  const p = (name: string) => `${PEOPLE_ROOT}/${name}`;
  // Both parents were expanded down; gustav's brought nils, hedda's found him already there.
  const nodes = {
    [p('anna')]: node('anna', { parents: [p('gustav'), p('hedda')], parentCount: 2 }),
    [p('gustav')]: node('gustav', { children: [p('anna'), p('nils')], partners: [{ path: p('hedda') }], childCount: 2 }),
    [p('hedda')]: node('hedda', { children: [p('anna'), p('nils')], partners: [{ path: p('gustav') }], childCount: 2 }),
    [p('nils')]: node('nils', { parents: [p('gustav'), p('hedda')], parentCount: 2 }),
  };
  const expansions = [
    { path: p('gustav'), direction: 'down' as const, added: [p('nils')] },
    { path: p('hedda'), direction: 'down' as const, added: [] },
  ];
  const folded = collapseFamilyNodes(p('anna'), nodes, expansions, p('gustav'), 'down');
  assertEquals(folded.nodes[p('nils')], undefined);
  // Hedda no longer shows all her children, so she offers to expand again.
  assertEquals(folded.expansions, []);
});

Deno.test('family graph replay: expands are made again on a fresh slice, and one whose card is gone is dropped', () => {
  const p = (name: string) => `${PEOPLE_ROOT}/${name}`;
  // Fresh opening slice after an edit: anna and her mother; her father was removed.
  const base = {
    [p('anna')]: node('anna', { parents: [p('mor')], parentCount: 1 }),
    [p('mor')]: node('mor', { children: [p('anna')], childCount: 1, parentCount: 1 }),
  };
  const expansions = [
    { path: p('mor'), direction: 'up' as const, added: [p('mormor')] },
    { path: p('far'), direction: 'up' as const, added: [p('farmor')] },
    { path: p('mormor'), direction: 'up' as const, added: [] },
  ];
  const slices = [
    { [p('mor')]: node('mor', { parents: [p('mormor')], parentCount: 1 }), [p('mormor')]: node('mormor', { children: [p('mor')], parentCount: 1 }) },
    { [p('far')]: node('far'), [p('farmor')]: node('farmor') },
    { [p('mormor')]: node('mormor', { parents: [p('mormorsmor')], parentCount: 1 }), [p('mormorsmor')]: node('mormorsmor', { children: [p('mormor')] }) },
  ];

  const replayed = replayFamilyExpansions(base, expansions, slices);

  assertEquals(Object.keys(replayed.nodes).sort(), [p('anna'), p('mor'), p('mormor'), p('mormorsmor')].sort());
  assertEquals(replayed.expansions, [
    { path: p('mor'), direction: 'up', added: [p('mormor')] },
    { path: p('mormor'), direction: 'up', added: [p('mormorsmor')] },
  ]);
  assertEquals(replayed.nodes[p('mor')].children, [p('anna')]);
});
