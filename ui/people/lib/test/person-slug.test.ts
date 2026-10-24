/**
 * The UI's copy of the server's slug rule.
 *
 * The cases that matter: a name whose letters have no decomposition, where
 * stripping instead of transliterating throws them away entirely.
 */

import { assertEquals } from '@std/assert';
import { personSlug } from '../person-slug.ts';

Deno.test('person slug: transliterates rather than stripping', () => {
  // Stripping would give `sa-berg`.
  assertEquals(personSlug('Åsa Öberg'), 'asa-oberg');
  assertEquals(personSlug('Søren Kjær'), 'soren-kjaer');
  assertEquals(personSlug('Weiß'), 'weiss');
  assertEquals(personSlug('Begoña Muñoz'), 'begona-munoz');
  assertEquals(personSlug('François'), 'francois');
});

Deno.test('person slug: accents that do decompose are handled too', () => {
  assertEquals(personSlug('José Ramírez'), 'jose-ramirez');
  assertEquals(personSlug('Renée'), 'renee');
});

Deno.test('person slug: punctuation and spacing collapse to single dashes', () => {
  assertEquals(personSlug('  Anna   Maria  '), 'anna-maria');
  assertEquals(personSlug("O'Brien-Smith"), 'o-brien-smith');
  assertEquals(personSlug('Anna (née Berg)'), 'anna-nee-berg');
});

Deno.test('person slug: a name with nothing usable left comes back empty', () => {
  // The caller decides what to do about it — the modals fall back rather than
  // sending `person-create /people/`.
  assertEquals(personSlug('???'), '');
  assertEquals(personSlug(''), '');
});
