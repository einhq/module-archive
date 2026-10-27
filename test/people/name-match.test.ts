import { assertEquals } from '@std/assert';
import { namesHaveWords, nameWords } from '../../lib/people/name-match.ts';

Deno.test('every typed word in one of the names, in any order and with names between', () => {
  const names = ['Anna', 'Anna B K Andersson', undefined];
  assertEquals(namesHaveWords(nameWords('Anna Andersson'), names), true);
  assertEquals(namesHaveWords(nameWords('andersson an'), names), true);
  assertEquals(namesHaveWords(nameWords('Anna Berg'), names), false);
  assertEquals(namesHaveWords(nameWords('  '), names), false);
});
