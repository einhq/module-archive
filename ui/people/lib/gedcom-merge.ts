import type { GedcomChoice, GedcomPlan, GedcomPlanPerson } from '@archive/people/api';
import type { FamilyGraph, FamilyNode } from '@ein/ui/lib';

type PlanIndividual = GedcomPlan['individuals'][number];

/**
 * What a card of the merged tree is: an individual of the file found in the archive (`found`),
 * said to be someone (`chosen`), fitting people none of whom was taken (`unsure`), to be made a
 * new person (`new`) or left out (`skip`); or one of the archive's people the file does not hold
 * (`archive`), drawn because a matched person is related to them.
 */
export type MergeKind = 'found' | 'chosen' | 'unsure' | 'new' | 'skip' | 'archive';

/** A card of the merged tree: an individual, with the person they are matched to, or a person alone. */
export type MergeCard = { key: string; kind: MergeKind; individual?: PlanIndividual; person?: string; archive?: GedcomPlanPerson };

/** One connected part of the merged tree, drawn as a tree of its own. */
type MergeTree = { graph: FamilyGraph; size: number };

export type Merge = {
  cards: Record<string, MergeCard>;
  /** The parts with a relation in them, largest first. */
  trees: MergeTree[];
  /** The individuals related to nobody the tree draws. */
  loose: string[];
};

const kindOf = (indi: PlanIndividual): MergeKind => {
  if (indi.action === 'match') return indi.chosen ? 'chosen' : 'found';
  if (indi.action === 'skip') return 'skip';
  return !indi.chosen && indi.candidates.length > 0 ? 'unsure' : 'new';
};

/**
 * The file's tree and the archive's as one: a card per individual, keyed by xref, and a card per
 * person of the archive related to someone matched, keyed by path. A matched individual's card
 * stands for their person too, so the relations of both meet on it: the file's between
 * individuals, the archive's between the people drawn. Cut into its connected parts, as the tree
 * draws one family from one person.
 */
export function buildMerge(plan: GedcomPlan): Merge {
  const cards: Record<string, MergeCard> = {};
  const keyOfPerson = new Map<string, string>();
  for (const indi of plan.individuals) {
    cards[indi.xref] = { key: indi.xref, kind: kindOf(indi), individual: indi, ...(indi.person ? { person: indi.person, archive: plan.people[indi.person] } : {}) };
    if (indi.person) keyOfPerson.set(indi.person, indi.xref);
  }
  for (const indi of plan.individuals) {
    const person = indi.person ? plan.people[indi.person] : undefined;
    for (const path of person ? [...person.parents, ...person.children, ...person.partners] : []) {
      if (keyOfPerson.has(path) || !plan.people[path]) continue;
      keyOfPerson.set(path, path);
      cards[path] = { key: path, kind: 'archive', person: path, archive: plan.people[path] };
    }
  }

  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const partners = new Map<string, Set<string>>();
  const add = (relation: Map<string, Set<string>>, a: string, b: string) => {
    if (!relation.has(a)) relation.set(a, new Set());
    relation.get(a)!.add(b);
  };
  const relate = (kind: 'parent' | 'partner', a: string | undefined, b: string | undefined) => {
    if (!a || !b || a === b) return;
    if (kind === 'partner') {
      add(partners, a, b);
      add(partners, b, a);
    } else {
      add(parents, a, b);
      add(children, b, a);
    }
  };
  for (const indi of plan.individuals) {
    for (const parent of indi.parents) if (cards[parent]) relate('parent', indi.xref, parent);
    for (const partner of indi.partners) if (cards[partner]) relate('partner', indi.xref, partner);
  }
  for (const [path, key] of keyOfPerson) {
    const person = plan.people[path];
    if (!person) continue;
    for (const parent of person.parents) relate('parent', key, keyOfPerson.get(parent));
    for (const partner of person.partners) relate('partner', key, keyOfPerson.get(partner));
  }

  const nodeOf = (card: MergeCard): FamilyNode => {
    const shown = card.individual ?? card.archive!;
    const up = [...parents.get(card.key) ?? []];
    const down = [...children.get(card.key) ?? []];
    return {
      path: card.key,
      name: shown.name || card.key,
      ...(shown.fullname ? { fullname: shown.fullname } : {}),
      ...(shown.gender ? { gender: shown.gender } : {}),
      ...(shown.born ? { born: shown.born } : {}),
      ...(shown.died ? { died: shown.died } : {}),
      parents: up,
      children: down,
      partners: [...partners.get(card.key) ?? []].map((path) => ({ path })),
      parentCount: up.length,
      childCount: down.length,
    };
  };

  // The parts, each from its first card in the file's order: individuals first, then the archive's.
  const seen = new Set<string>();
  const trees: MergeTree[] = [];
  const loose: string[] = [];
  for (const key of Object.keys(cards)) {
    if (seen.has(key)) continue;
    const part: string[] = [];
    for (const queue = [key]; queue.length > 0;) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      part.push(next);
      for (const relation of [parents, children, partners]) queue.push(...relation.get(next) ?? []);
    }
    if (part.length === 1) {
      if (cards[key].individual) loose.push(key);
      continue;
    }
    trees.push({ size: part.length, graph: { root: key, nodes: Object.fromEntries(part.map((each) => [each, nodeOf(cards[each])])) } });
  }
  trees.sort((a, b) => b.size - a.size);
  return { cards, trees, loose };
}

/** The flags that say `choices` to `gedcom-read` and `gedcom-import`, as words to quote. */
export const choiceWords = (choices: Record<string, GedcomChoice>): string[] =>
  Object.entries(choices).flatMap(([xref, choice]) =>
    choice.kind === 'person' ? ['--match', `${xref}=${choice.person}`] : choice.kind === 'new' ? ['--new', xref] : ['--skip', xref]
  );

/**
 * How the import treats what the file says of a person it matched: an attr the archive lacks is
 * `added`; one it has is kept, `same` or `differs`.
 */
export const attrFate = (file: string | undefined, archive: string | undefined): 'added' | 'same' | 'differs' | null => {
  if (!file) return null;
  if (!archive) return 'added';
  return file.toLowerCase() === archive.toLowerCase() ? 'same' : 'differs';
};
