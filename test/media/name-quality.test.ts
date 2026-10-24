import { assertEquals } from '@std/assert';
import { nameScore } from '../../lib/media/name-quality.ts';

/** The `name` channel's bar for a name that is what the query means. */
const CONFIDENT = 0.75;

Deno.test('an exact name and a prefix that ends a word are confident', () => {
  assertEquals(nameScore('anna andersson', 'Anna Andersson'), 1);
  assertEquals(nameScore('anna', 'Anna Andersson'), 0.8);
  assertEquals(nameScore('ekudden', 'Ekudden_4'), 0.8);
});

Deno.test('a prefix inside a word is not confident, but ranks above a substring', () => {
  const inside = nameScore('fyr', 'Fyrtornet 4');
  const substring = nameScore('torn', 'Fyrtornet 4');
  assertEquals(inside < CONFIDENT, true);
  assertEquals(substring < inside, true);
  assertEquals(nameScore('slott', 'Slottsparken'), inside);
});

Deno.test('a substring stays below a confident name however much of it the query is', () => {
  assertEquals(nameScore('nna andersson', 'Anna Andersson') < CONFIDENT, true);
  assertEquals(nameScore('båt', 'Segelbåtar'), 0.5);
  assertEquals(nameScore('x', undefined), 0);
  assertEquals(nameScore('ö', 'Anna'), 0);
});
