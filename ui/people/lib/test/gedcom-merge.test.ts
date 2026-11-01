/**
 * The merged tree of a GEDCOM file and the archive: a matched individual's card is their person's
 * too, so the file's relations and the archive's meet on it; the archive's people related to the
 * matched ones are drawn beside them; unrelated parts are trees of their own, and a lone
 * individual is no tree at all.
 */

import { assertEquals } from '@std/assert';
import type { GedcomPlan } from '@archive/people/api';
import { attrFate, buildMerge, choiceWords } from '../gedcom-merge.ts';

type Individual = GedcomPlan['individuals'][number];

const indi = (xref: string, name: string, over: Partial<Individual> = {}): Individual => ({
  xref,
  name,
  parents: [],
  children: [],
  partners: [],
  action: 'new',
  chosen: false,
  candidates: [],
  ...over,
});

const person = (name: string, over: Partial<GedcomPlan['people'][string]> = {}): GedcomPlan['people'][string] => ({
  name,
  parents: [],
  children: [],
  partners: [],
  writable: true,
  ...over,
});

const PLAN: GedcomPlan = {
  file: '/home/anna/staging/genealogy/tree.ged',
  source: '/home/anna/staging/genealogy/tree.ged',
  individuals: [
    indi('@I1@', 'Harold Wrenfield', { children: ['@I2@'], action: 'match', person: '/p/harold', how: 'name-date' }),
    indi('@I2@', 'Ruby Wrenfield', { parents: ['@I1@'], candidates: [{ person: '/p/ruby', score: 1 }, { person: '/p/ruby-2', score: 1 }] }),
    indi('@I3@', 'Tom Pole', { partners: ['@I4@'], action: 'match', chosen: true, person: '/p/tom', how: 'chosen' }),
    indi('@I4@', 'Lily Pole', { partners: ['@I3@'], action: 'skip', chosen: true }),
    indi('@I5@', 'Clara Wrenfield'),
  ],
  people: {
    // Harold has a wife in the archive the file does not name.
    '/p/harold': person('Harold Wrenfield', { partners: ['/p/margaret'], children: ['/p/ruby'] }),
    '/p/margaret': person('Margaret Wrenfield', { partners: ['/p/harold'], children: ['/p/ruby'] }),
    '/p/ruby': person('Ruby', { parents: ['/p/harold', '/p/margaret'] }),
    '/p/ruby-2': person('Ruby'),
    '/p/tom': person('Tom Pole'),
  },
};

Deno.test('gedcom merge: cards say what the import does with each', () => {
  const { cards } = buildMerge(PLAN);
  assertEquals(Object.fromEntries(Object.values(cards).map((card) => [card.key, card.kind])), {
    '@I1@': 'found',
    '@I2@': 'unsure',
    '@I3@': 'chosen',
    '@I4@': 'skip',
    '@I5@': 'new',
    '/p/margaret': 'archive',
    '/p/ruby': 'archive',
  });
  assertEquals(cards['@I1@'].archive?.name, 'Harold Wrenfield');
});

Deno.test("gedcom merge: the file's relations and the archive's meet on a matched card", () => {
  const { trees, loose } = buildMerge(PLAN);
  assertEquals(trees.map((tree) => [tree.graph.root, Object.keys(tree.graph.nodes).sort()]), [
    ['@I1@', ['/p/margaret', '/p/ruby', '@I1@', '@I2@'].sort()],
    ['@I3@', ['@I3@', '@I4@']],
  ]);
  const harold = trees[0].graph.nodes['@I1@'];
  assertEquals([harold.children.sort(), harold.partners.map((p) => p.path)], [['/p/ruby', '@I2@'].sort(), ['/p/margaret']]);
  // The archive's Ruby has both her parents, one of them drawn as the file's Harold.
  assertEquals(trees[0].graph.nodes['/p/ruby'].parents.sort(), ['/p/margaret', '@I1@'].sort());
  assertEquals(trees[0].graph.nodes['@I2@'].parentCount, 1);
  assertEquals(loose, ['@I5@']);
});

Deno.test('gedcom merge: choices are the import flags', () => {
  assertEquals(choiceWords({ '@I1@': { kind: 'person', person: '/p/harold' }, '@I2@': { kind: 'new' }, '@I3@': { kind: 'skip' } }), [
    '--match',
    '@I1@=/p/harold',
    '--new',
    '@I2@',
    '--skip',
    '@I3@',
  ]);
});

Deno.test('gedcom merge: what the file says fills in, and never replaces', () => {
  assertEquals([attrFate('1931-03-03', undefined), attrFate('1931', '1931'), attrFate('Harold', 'Hal'), attrFate(undefined, 'Hal')], ['added', 'same', 'differs', null]);
});
