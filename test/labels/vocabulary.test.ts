/** The vocabulary: every word is a label `label` takes, and no language has one word twice. */

import { assert, assertEquals } from '@std/assert';
import { VOCABULARY, vocabularyFor } from '@archive/labels/vocabulary';

Deno.test('every word is one label word, and unique in its language', () => {
  for (const language of ['en', 'sv']) {
    const words = vocabularyFor(language).map((entry) => entry.label);
    assertEquals(words.length, VOCABULARY.length, language);
    assertEquals(new Set(words).size, words.length, `${language} has a word twice`);
    for (const word of words) assert(/^[^/\s]+$/.test(word), `${language}: '${word}' is not a label`);
  }
});

Deno.test('a language with no words gets none', () => {
  assertEquals(vocabularyFor('xx'), []);
});
