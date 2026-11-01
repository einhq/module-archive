/**
 * Reading GEDCOM: character sets, names, dates, families, events and notes; which individuals the
 * matcher takes to be people the archive has, and what choosing for an individual changes.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { decodeAnsel, decodeGedcom, parseGedcomDate, readGedcom } from '@archive/people/gedcom';
import { type ArchivePerson, choicesFromFlags, matchIndividuals, score } from '@archive/people/gedcom-import';

const enc = (text: string) => new TextEncoder().encode(text);

const TREE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Harold /Wrenfield/
1 SEX M
1 BIRT
2 DATE 3 MAR 1931
1 DEAT
2 DATE ABT 2004
1 FAMS @F1@
1 _UID 7A1B
0 @I2@ INDI
1 NAME Margaret Ann* /Pole/
1 NAME Margaret Ann /Wrenfield/
2 TYPE married
1 SEX F
1 BIRT
2 DATE 1934
1 FAMS @F1@
0 @I3@ INDI
1 NAME Ruby /Wrenfield/
1 SEX F
1 BIRT
2 DATE 12 JUN 1962
1 FAMC @F1@
0 @I4@ INDI
1 NAME Tom /Wrenfield/
1 SEX M
1 FAMC @F1@
2 PEDI adopted
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 20 AUG 1958
0 TRLR
`;

Deno.test('readGedcom reads names, call names, married names, dates and families', () => {
  const { individuals, families } = readGedcom(enc(TREE));
  const [harold, margaret, ruby, tom] = individuals;
  assertEquals([harold.given, harold.surname, harold.gender, harold.uids], [['Harold'], 'Wrenfield', 'male', ['7A1B']]);
  assertEquals(harold.born, { date: '1931-03-03', from: 1931, to: 1931 });
  // An approximate date gives years to match by, and no date to keep.
  assertEquals(harold.died, { from: 2002, to: 2006 });
  assertEquals([margaret.given, margaret.callName, margaret.surname, margaret.marriedSurname], [['Margaret', 'Ann'], 'Ann', 'Pole', 'Wrenfield']);
  assertEquals(ruby.childOf, [{ family: '@F1@', kind: 'blood' }]);
  assertEquals(tom.childOf, [{ family: '@F1@', kind: 'adoptive' }]);
  assertEquals(families.map(({ events: _, ...family }) => family), [{
    xref: '@F1@',
    partners: ['@I1@', '@I2@'],
    children: ['@I3@', '@I4@'],
    married: true,
    marriedOn: '1958-08-20',
  }]);
});

Deno.test('readGedcom reads events with their places, periods, causes and notes, a shared note by its pointer', () => {
  const { individuals, families } = readGedcom(enc(`0 HEAD
0 @I1@ INDI
1 NAME Harold /Wrenfield/
1 BIRT Y
2 PLAC Lower Wrenfield, Kent
1 OCCU Boatbuilder
2 DATE FROM 1950 TO 1975
1 RESI
2 ADDR 4 Mill Lane
3 CONT Lower Wrenfield
1 DEAT
2 CAUS Old age
1 NOTE Kept a boatyard
2 CONT by the river.
1 NOTE @N1@
1 SSN 123
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 PLAC Saint Ann's
2 SNOTE @N1@
0 @N1@ NOTE Told by Ruby.
`));
  const [harold] = individuals;
  assertEquals(harold.events, [
    { tag: 'BIRT', place: 'Lower Wrenfield, Kent', notes: [] },
    { tag: 'OCCU', value: 'Boatbuilder', date: { from: 1950, to: 1975, since: '1950', until: '1975' }, notes: [] },
    { tag: 'RESI', place: '4 Mill Lane, Lower Wrenfield', notes: [] },
    { tag: 'DEAT', cause: 'Old age', notes: [] },
  ]);
  assertEquals(harold.notes, ['Kept a boatyard\nby the river.', 'Told by Ruby.']);
  assertEquals(families[0].events, [{ tag: 'MARR', place: "Saint Ann's", notes: ['Told by Ruby.'] }]);
});

Deno.test('parseGedcomDate keeps a plain date and turns the qualified ones into years', () => {
  assertEquals(parseGedcomDate('MAR 1900'), { date: '1900-03', from: 1900, to: 1900 });
  assertEquals(parseGedcomDate('@#DJULIAN@ 11 FEB 1731/32'), { date: '1731-02-11', from: 1731, to: 1731 });
  assertEquals(parseGedcomDate('BET 1850 AND 1855'), { from: 1850, to: 1855 });
  assertEquals(parseGedcomDate('FROM MAR 1950 TO 1955'), { from: 1950, to: 1955, since: '1950-03', until: '1955' });
  assertEquals(parseGedcomDate('FROM 1950'), { from: 1950, to: 2050, since: '1950' });
  assertEquals(parseGedcomDate('BEF 1900'), { from: 1800, to: 1900 });
  assertEquals(parseGedcomDate('CAL 1890'), { date: '1890', from: 1890, to: 1890 });
  assertEquals(parseGedcomDate('UNKNOWN'), undefined);
});

Deno.test('decodeGedcom reads ANSEL, Windows-1252, UTF-8 and UTF-16', () => {
  // ANSEL writes the mark before its letter: E8 is the diaeresis, EA the ring.
  assertEquals(decodeAnsel(new Uint8Array([0x45, 0x6B, 0xE8, 0x6F, 0x20, 0xEA, 0x41, 0x73, 0x61])), 'Ekö Åsa');
  const ansel = new Uint8Array([...enc('0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI\n1 NAME '), 0xEA, 0x41, 0x73, 0x61, ...enc(' /Wrenfield/\n')]);
  assertEquals(readGedcom(ansel).individuals[0].given, ['Åsa']);
  const ansi = new Uint8Array([...enc('0 HEAD\n1 CHAR ANSI\n0 @I1@ INDI\n1 NAME '), 0xC5, 0x73, 0x61, ...enc(' //\n')]);
  assertEquals(readGedcom(ansi).individuals[0].given, ['Åsa']);
  assertEquals(decodeGedcom(new Uint8Array([0xEF, 0xBB, 0xBF, ...enc('0 HEAD')])), '0 HEAD');
  const utf16 = new Uint8Array([0xFF, 0xFE, ...[...'0 HEAD'].flatMap((ch) => [ch.charCodeAt(0), 0])]);
  assertEquals(decodeGedcom(utf16), '0 HEAD');
});

Deno.test('CONT and CONC continue the value they follow', () => {
  const { individuals } = readGedcom(enc('0 HEAD\n0 @I1@ INDI\n1 NAME Ru\n2 CONC by /Wren\n2 CONC field/\n'));
  assertEquals([individuals[0].given, individuals[0].surname], [['Ruby'], 'Wrenfield']);
});

const person = (path: string, attrs: ArchivePerson['attrs'], more: Partial<ArchivePerson> = {}): ArchivePerson => ({
  path,
  attrs,
  parents: [],
  children: [],
  partners: [],
  writable: true,
  gedcom: [],
  ...more,
});

Deno.test('score wants the first name, and refuses a contradicting date, gender or name', () => {
  const [harold] = readGedcom(enc(TREE)).individuals;
  assertEquals(score(person('/p/h', { name: 'Harold Wrenfield', born: '1931' }), harold), 4);
  assertEquals(score(person('/p/h', { name: 'Harold Wrenfield', born: '1931-03-03' }), harold), 6);
  assertEquals(score(person('/p/h', { name: 'Harold' }), harold), 1);
  assertEquals(score(person('/p/h', { name: 'Harold Wrenfield', born: '1932' }), harold), 0);
  assertEquals(score(person('/p/h', { name: 'Harold Wrenfield', gender: 'female' }), harold), 0);
  assertEquals(score(person('/p/h', { name: 'Harold Pole' }), harold), 0);
  assertEquals(score(person('/p/h', { name: 'Grandpa' }), harold), 0);
});

Deno.test('matchIndividuals takes sure fits, confirms a name by its relatives, and leaves a tie', () => {
  const gedcom = readGedcom(enc(TREE));
  const people = [
    person('/p/harold', { name: 'Harold Wrenfield', born: '1931-03-03' }, { children: ['/p/ruby'] }),
    // Only a first name: taken because her father matched, and he is her parent here too.
    person('/p/ruby', { name: 'Ruby' }, { parents: ['/p/harold'] }),
    // Two Toms with nothing else to go by: neither is taken.
    person('/p/tom', { name: 'Tom Wrenfield' }),
    person('/p/tom-2', { name: 'Tom Wrenfield' }),
  ];
  const matches = matchIndividuals(gedcom, people, '/archive/sources/genealogy/tree.ged');
  assertEquals(Object.fromEntries([...matches].map(([xref, m]) => [xref, [m.path, m.how]])), {
    '@I1@': ['/p/harold', 'name-date'],
    '@I3@': ['/p/ruby', 'relatives'],
  });
});

Deno.test('matchIndividuals finds an earlier import by its link, or by the _UID', () => {
  const gedcom = readGedcom(enc(TREE));
  const source = '/archive/sources/genealogy/tree.ged';
  const people = [
    person('/p/someone', { name: 'Someone Else' }, { gedcom: [{ target: source, xref: '@I3@', uids: [] }] }),
    person('/p/other', { name: 'Another' }, { gedcom: [{ target: '/archive/sources/genealogy/older.ged', xref: '@I77@', uids: ['7A1B'] }] }),
  ];
  const matches = matchIndividuals(gedcom, people, source);
  assertEquals(matches.get('@I3@')?.path, '/p/someone');
  assertEquals([matches.get('@I1@')?.path, matches.get('@I1@')?.how], ['/p/other', 'uid']);
});

Deno.test('matchIndividuals puts choices first, and a chosen person confirms their relatives', () => {
  const gedcom = readGedcom(enc(TREE));
  const people = [
    person('/p/harold', { name: 'Harold Wrenfield', born: '1931-03-03' }, { children: ['/p/ruby'] }),
    person('/p/hal', { name: 'Hal' }, { children: ['/p/ruby-2'] }),
    person('/p/ruby', { name: 'Ruby' }, { parents: ['/p/harold'] }),
    person('/p/ruby-2', { name: 'Ruby' }, { parents: ['/p/hal'] }),
  ];
  const source = '/archive/sources/genealogy/tree.ged';
  const how = (choices: ReturnType<typeof choicesFromFlags>) =>
    Object.fromEntries([...matchIndividuals(gedcom, people, source, choices)].map(([xref, m]) => [xref, [m.path, m.how]]));

  // Harold is said to be Hal: his daughter is then Hal's Ruby, and the other Harold is nobody's.
  assertEquals(how(choicesFromFlags({ match: ['@I1@=/p/hal'] }, '/')), { '@I1@': ['/p/hal', 'chosen'], '@I3@': ['/p/ruby-2', 'relatives'] });
  // Said to be new, Harold matches nobody, and so confirms nobody.
  assertEquals(how(choicesFromFlags({ new: ['I1'] }, '/')), {});
  // Left out, the same.
  assertEquals(how(choicesFromFlags({ skip: ['@i1@'] }, '/')), {});
});

Deno.test('choicesFromFlags reads xrefs loosely and people as paths or names', () => {
  const choices = choicesFromFlags({ match: ['I1=harold', '@I2@=/archive/people/ann'], new: ['@I3@'], skip: ['i4'] }, '/');
  assertEquals(Object.fromEntries(choices), {
    '@I1@': { kind: 'person', person: '/archive/people/harold' },
    '@I2@': { kind: 'person', person: '/archive/people/ann' },
    '@I3@': { kind: 'new' },
    '@I4@': { kind: 'skip' },
  });
  assertThrows(() => choicesFromFlags({ match: ['@I1@'] }, '/'), Error, '<xref>=<person>');
  assertThrows(() => choicesFromFlags({ match: ['@I1@=harold'], skip: ['@I1@'] }, '/'), Error, 'chosen twice');
});
