/**
 * Spelling rules for names: a rules file read line by line, mistakes said with where they are,
 * and the archive's own rules reading Swedish and English spellings of one name as one, and
 * different names as different. With them, a person who fits only by spelling is taken when the
 * day of birth is the same, and otherwise only suggested.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { readGedcom } from '@archive/people/gedcom';
import { type ArchivePerson, matchIndividuals, score } from '@archive/people/gedcom-import';
import { parseSpellings, speller } from '@archive/people/name-spellings';

const shipped = speller(parseSpellings(await Deno.readTextFile(fromFileUrl(new URL('../../etc/name-spellings.d/spellings', import.meta.url))), 'spellings'));

Deno.test('a rules file: one rule a line, comments and blank lines aside, mistakes said with their line', () => {
  const rules = parseSpellings('# a comment\n\nck -> k   # Eriksson\n(?<=.)h ->\n(.)\\1+ -> $1\n', 'local');
  assertEquals(rules.length, 3);
  assertEquals(speller(rules)('ohlsson'), 'olson');
  assertThrows(() => parseSpellings('ck k\n', 'local'), Error, "local:1: a rule is '<from> -> <to>'");
  assertThrows(() => parseSpellings('\n(ck -> k\n', 'local'), Error, "local:2: '(ck' is not a regular expression");
});

Deno.test("the archive's rules read spellings of one name as one, and different names apart", () => {
  const same = [
    ['eriksson', 'ericsson'],
    ['olsson', 'ohlson'],
    ['olsson', 'olsen'],
    ['persson', 'pehrsson'],
    ['jakobsson', 'jacobsson'],
    ['gustafsson', 'gustafson'],
    ['gustaf', 'gustav'],
    ['carl', 'karl'],
    ['christina', 'kristina'],
    ['thompson', 'thomson'],
    ['macdonald', 'mcdonald'],
    ['clarke', 'clark'],
    ['smyth', 'smith'],
    ['phillips', 'philips'],
    ['catherine', 'katherine'],
    ['elizabeth', 'elisabeth'],
  ];
  for (const [a, b] of same) assertEquals(shipped(a), shipped(b), `${a} and ${b}`);
  const different = [['eriksson', 'andersson'], ['karlsson', 'larsson'], ['jakobsson', 'johansson'], ['olsson', 'nilsson'], ['anna', 'maria']];
  for (const [a, b] of different) assertEquals(shipped(a) === shipped(b), false, `${a} and ${b}`);
});

const person = (path: string, attrs: ArchivePerson['attrs']): ArchivePerson => ({ path, attrs, parents: [], children: [], partners: [], writable: true, gedcom: [] });

Deno.test('a person who fits only by spelling is taken on the same day of birth, and only suggested on less', () => {
  const gedcom = readGedcom(new TextEncoder().encode(
    '0 HEAD\n0 @I1@ INDI\n1 NAME Ellen /Ericsson/\n1 BIRT\n2 DATE 15 JAN 1888\n0 @I2@ INDI\n1 NAME Andreas /Jakobsson/\n1 BIRT\n2 DATE 18 APR 1779\n',
  ));
  const [ellen, andreas] = gedcom.individuals;
  const people = [person('/p/ellen', { name: 'Ellen Eriksson', born: '1888-01-15' }), person('/p/andreas', { name: 'Andreas Jacobsson', born: '1779' })];
  // As written the names do not meet; read by the rules they do.
  assertEquals(score(people[0], ellen), 0);
  assertEquals(score(people[0], ellen, shipped), 6);
  assertEquals(score(people[1], andreas, shipped), 0);
  const matches = matchIndividuals(gedcom, people, '/archive/sources/genealogy/tree.ged', new Map(), shipped);
  assertEquals([...matches].map(([xref, match]) => [xref, match.path]), [['@I1@', '/p/ellen']]);
});
