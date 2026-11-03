import { assertEquals } from '@std/assert';
import { nameHasWholeWords, namesHaveWords, nameWords } from '../../lib/people/name-match.ts';

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
