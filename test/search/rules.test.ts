/**
 * The deterministic pass. This is what natural-language search degrades to when the model
 * server is down, so the cases here are the promise: years and content kinds still work, in
 * both languages, and nothing else is guessed at.
 */

import { assertEquals } from '@std/assert';
import { contentWords, parseWithRules, stripNamedFilters } from '@archive/search/rules';

Deno.test('a single year becomes a closed range and leaves no filter glue', () => {
  const result = parseWithRules('photos from 2011');
  assertEquals(result.kinds, ['photo']);
  // --to is bucket-exclusive, so the same year on both bounds covers all of it.
  assertEquals([result.from, result.to], ['2011', '2011']);
  // Matched words are removed so they are not also embedded as a semantic query.
  assertEquals(result.text, '');
});

Deno.test('two years span a range', () => {
  const result = parseWithRules('bilder mellan 1998 och 2004');
  assertEquals(result.kinds, ['photo']);
  assertEquals([result.from, result.to], ['1998', '2004']);
});

Deno.test('before and after make a one-sided year bound', () => {
  assertEquals(parseWithRules('pictures of snow before 2010'), {
    text: 'snow',
    kinds: ['photo'],
    to: '2010',
  });
  assertEquals(parseWithRules('fotografier av båtar efter 2020'), {
    text: 'båtar',
    kinds: ['photo'],
    from: '2020',
  });
});

Deno.test('Swedish kind words are recognised', () => {
  assertEquals(parseWithRules('filmer').kinds, ['video']);
  assertEquals(parseWithRules('foton och videor').kinds, ['photo', 'video']);
  assertEquals(parseWithRules('dokument').kinds, ['document']);
});

Deno.test('a number that is not a plausible year is left in the text', () => {
  const result = parseWithRules('room 2130 and 3021');
  assertEquals(result.from, undefined);
  assertEquals(result.text, 'room 2130 and 3021');
});

Deno.test('names and locations are never guessed at', () => {
  // Capitalisation is not evidence. Leaving them in the text still matches semantically,
  // where a wrong --person filter would return someone else's photos with no sign of it.
  const result = parseWithRules('pictures of Olof in Italy');
  assertEquals(result, { text: 'Olof in Italy', kinds: ['photo'] });
});

Deno.test('literal model mentions are removed from the embedding text', () => {
  assertEquals(stripNamedFilters('Anna and Erik at the beach', ['Anna', 'Erik']), 'beach');
  assertEquals(stripNamedFilters('Stina at Liseberg with a blue umbrella', ['Stina', 'Liseberg']), 'blue umbrella');
  assertEquals(stripNamedFilters('boats near the Golden Gate Bridge', ['Golden Gate Bridge']), 'boats');
  const swedish = parseWithRules('bilder på Olof och Stina i Italien');
  assertEquals(stripNamedFilters(swedish.text, ['Olof', 'Stina', 'Italien']), '');
});

Deno.test('a plain description passes through untouched', () => {
  const result = parseWithRules('red sailing boat');
  assertEquals(result.text, 'red sailing boat');
  assertEquals(result.kinds, []);
  assertEquals(result.from, undefined);
});

Deno.test('an empty query is an empty extraction', () => {
  assertEquals(parseWithRules('   ').text, '');
});

Deno.test('contentWords strips the verb, the kind word and the glue, keeping the content', () => {
  assertEquals(contentWords('Visa'), '');
  assertEquals(contentWords('Visa bilder på'), '');
  assertEquals(contentWords('show me photos of'), '');
  assertEquals(contentWords('Visa bilder på en segelbåt med'), 'en segelbåt');
  assertEquals(contentWords('find pictures of a red car from'), 'a red car');
  assertEquals(contentWords('sunset over the sea'), 'sunset over the sea');
  assertEquals(contentWords('Visa 6 bilder på'), '');
  assertEquals(contentWords('visa fler bilder på'), '');
  assertEquals(contentWords('6'), '');
  assertEquals(contentWords('fler'), '');
  assertEquals(contentWords('show some more photos of a boat'), 'a boat');
});
