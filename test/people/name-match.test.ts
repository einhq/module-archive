import { assertEquals } from '@std/assert';
import { byNameMatch, nameHasWholeWords, nameMatchRank, namesHaveWords, nameWords } from '../../lib/people/name-match.ts';

Deno.test('every typed word in one of the names, in any order and with names between', () => {
  const names = ['Anna', 'Anna B K Andersson', undefined];
  assertEquals(namesHaveWords(nameWords('Anna Andersson'), names), true);
  assertEquals(namesHaveWords(nameWords('andersson an'), names), true);
  assertEquals(namesHaveWords(nameWords('Anna Berg'), names), false);
  assertEquals(namesHaveWords(nameWords('  '), names), false);
});

Deno.test('two or more whole words of one name, hyphen parts included', () => {
  assertEquals(nameHasWholeWords('Anna Andersson', 'Anna B K Andersson'), true);
  assertEquals(nameHasWholeWords('anna andersson', 'Anna Berg-Andersson'), true);
  assertEquals(nameHasWholeWords('Gun-Britt Andersson', 'Gun-Britt K Andersson'), true);
  // A word that only starts one of the name's is a partial match, not this.
  assertEquals(nameHasWholeWords('Ann Andersson', 'Anna B Andersson'), false);
  // One word alone is a whole family's.
  assertEquals(nameHasWholeWords('Andersson', 'Anna B Andersson'), false);
  assertEquals(nameHasWholeWords('Anna Andersson', undefined), false);
});

Deno.test('the name typed out first, then whole words, word starts and words inside', () => {
  // As the naming box lists them before ranking: alphabetical, with full and birth names.
  const people: (string | undefined)[][] = [
    ['Abraham Johansson'],
    ['Andreas Johansson'],
    ['Anna Johansson'],
    ['Berta Jeppsson', undefined, 'Berta Johansson'],
    ['Ingemar Johansson'],
    ['Johan Holmberg', 'Johan Erik Holmberg', 'Johan Johansson'],
    ['Johan Johansson'],
    ['Johanna Johansson'],
  ];
  const ranked = byNameMatch(people, 'johan  Johansson', (names) => names).map(([name]) => name);
  assertEquals(ranked, [
    'Johan Johansson',
    'Johan Holmberg',
    'Johanna Johansson',
    'Abraham Johansson',
    'Andreas Johansson',
    'Anna Johansson',
    'Ingemar Johansson',
    'Berta Jeppsson',
  ]);
  // The name itself before the same name as someone's birth name.
  assertEquals(nameMatchRank('Johan Johansson', ['Johan Johansson']) < nameMatchRank('Johan Johansson', ['Johan Holmberg', undefined, 'Johan Johansson']), true);
  // Hyphens split typed words as they split names.
  assertEquals(nameMatchRank('Anna Berg-Andersson', ['Anna Berg-Andersson']), 0);
  assertEquals(nameMatchRank('ann', ['Anna Berg']) < nameMatchRank('ann', ['Lisa Hanna']), true);
});
