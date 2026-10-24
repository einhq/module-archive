/**
 * Kin phrases walked through a small family: the words, the chains, the gender filter, the
 * age span. The graph is built directly in an in-memory VFS, as the genealogy tests do.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestVfs, type NodeVFS } from '@ein/testing';
import { createRelationPair, makeCtx } from '@archive/people/genealogy';
import { ageSpan, KIN_WORDS, kinInMessage, parseKin, walkKin } from '@archive/people/kin';

Deno.test('parseKin reads Swedish and English kin words, chains and possessives, and nothing else', () => {
  assertEquals(parseKin('dotter')?.length, 1);
  assertEquals(parseKin('min mammas syster')?.length, 2);
  assertEquals(parseKin("my father's brother")?.length, 2);
  assertEquals(parseKin('Farfars bror')?.map((term) => term.chains[0].length), [2, 1]);
  assertEquals(parseKin('Olof Strand'), undefined);
  assertEquals(parseKin('mammas Anna'), undefined);
  assertEquals(parseKin(''), undefined);
  assertEquals(parseKin('min'), undefined);
  for (const word of ['moster', 'farbror', 'mormor', 'kusin', 'svärmor', 'stepdad', 'niece']) assertEquals(KIN_WORDS.includes(word), true, word);
});

Deno.test('kinInMessage finds the one kin phrase a question carries', () => {
  assertEquals(kinInMessage('vilka är mina kusiner?'), 'kusiner');
  assertEquals(kinInMessage('vem är min mammas syster'), 'mammas syster');
  assertEquals(kinInMessage("who is my father's brother?"), "father's brother");
  assertEquals(kinInMessage('kan du visa en bild på min dotter när hon var 6 år'), 'dotter');
  assertEquals(kinInMessage('visa bilder på min dotter och hennes farfar'), undefined);
  assertEquals(kinInMessage('Hur är Ingrid Strand och Harald Nyberg släkt?'), 'släkt');
  assertEquals(kinInMessage('bilder på Olof'), undefined);
});

Deno.test('ageSpan is the year someone was that age, as coarse as the birth date', () => {
  assertEquals(ageSpan('2008-03-14', 6), { from: '2014-03-14', to: '2015-03-14' });
  assertEquals(ageSpan('2008-03', 6), { from: '2014-03', to: '2015-03' });
  // A birth date may carry the time of birth; the span is still whole days.
  assertEquals(ageSpan('2018-04-18T10:34', 6), { from: '2024-04-18', to: '2025-04-18' });
  assertEquals(ageSpan('2008', 0), { from: '2008', to: '2009' });
  assertEquals(ageSpan('sometime', 6), undefined);
  assertEquals(ageSpan('2008', -1), undefined);
  assertEquals(ageSpan('2008', 6.5), undefined);
});

const person = (vfs: NodeVFS, name: string, attrs: Record<string, unknown>) =>
  vfs.create(ADMIN_ACCESS, 'person', '/p', name, { props: { uid: 1000, gid: 1000, mode: 0o755 }, attrs: { name, ...attrs } });
const addParent = (vfs: NodeVFS, child: string, parent: string) =>
  createRelationPair(vfs, ADMIN_ACCESS, { aLink: `/p/${child}/parents/${parent}`, aTarget: `/p/${parent}`, bLink: `/p/${parent}/children/${child}`, bTarget: `/p/${child}` });
const addPartner = (vfs: NodeVFS, a: string, b: string) =>
  createRelationPair(vfs, ADMIN_ACCESS, { aLink: `/p/${a}/partners/${b}`, aTarget: `/p/${b}`, bLink: `/p/${b}/partners/${a}`, bTarget: `/p/${a}` });

Deno.test('walkKin follows the words through the family', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'p', { props: { uid: 1000, gid: 1000, mode: 0o755 } });
    // Olga's mother Britt has a sister Karin and a brother Lars; Olga and Per have Eva and Nils;
    // Britt's second partner Sten is Olga's stepfather; Tove's gender was never filled in.
    for (
      const [name, attrs] of [
        ['britt', { gender: 'female' }],
        ['gunnar', { gender: 'male' }],
        ['karin', { gender: 'female', born: '1961-05-02' }],
        ['lars', { gender: 'male' }],
        ['sten', { gender: 'male' }],
        ['olga', { gender: 'female', born: '1985-01-01' }],
        ['per', { gender: 'male' }],
        ['eva', { gender: 'female', born: '2008-03-14' }],
        ['nils', { gender: 'male', born: '2011' }],
        ['tove', {}],
        ['ida', { gender: 'female' }],
      ] as [string, Record<string, unknown>][]
    ) {
      await person(vfs, name, attrs);
    }
    for (const child of ['britt', 'karin', 'lars']) for (const parent of ['ida']) await addParent(vfs, child, parent);
    await addParent(vfs, 'olga', 'britt');
    await addParent(vfs, 'olga', 'gunnar');
    await addPartner(vfs, 'britt', 'sten');
    await addPartner(vfs, 'olga', 'per');
    for (const child of ['eva', 'nils', 'tove']) for (const parent of ['olga', 'per']) await addParent(vfs, child, parent);

    const ctx = makeCtx(vfs, ADMIN_ACCESS);
    const walk = async (from: string, phrase: string) =>
      (await walkKin(ctx, `/p/${from}`, parseKin(phrase)!)).map((rel) => `${rel.slug}=${rel.relation.sv}/${rel.relation.en}`);

    assertEquals(await walk('olga', 'dotter'), ['eva=dotter/daughter']);
    assertEquals(await walk('olga', 'son'), ['nils=son/son']);
    assertEquals((await walk('olga', 'mina barn')).sort(), ['eva=dotter/daughter', 'nils=son/son', 'tove=barn/child']);
    assertEquals(await walk('olga', 'moster'), ['karin=moster/aunt']);
    assertEquals(await walk('olga', 'morbror'), ['lars=morbror/uncle']);
    assertEquals(await walk('olga', 'faster'), []);
    assertEquals(await walk('olga', 'mammas syster'), ['karin=moster/aunt']);
    assertEquals(await walk('olga', 'mormor'), ['ida=mormor/grandmother']);
    assertEquals(await walk('olga', 'grandmother'), ['ida=mormor/grandmother']);
    assertEquals(await walk('olga', 'styvfar'), ['sten=styvfar/stepfather']);
    assertEquals(await walk('olga', 'pappa'), ['gunnar=far/father']);
    assertEquals(await walk('olga', 'make'), ['per=partner/partner']);
    assertEquals(await walk('eva', 'mormor'), ['britt=mormor/grandmother']);
    assertEquals(await walk('eva', 'syskon').then((list) => list.sort()), ['nils=bror/brother', 'tove=syskon/sibling']);
    assertEquals(await walk('karin', 'systerdotter'), ['olga=systerdotter/niece']);
    assertEquals((await walk('olga', 'familj')).sort(), [
      'britt=mor/mother',
      'eva=dotter/daughter',
      'gunnar=far/father',
      'nils=son/son',
      'per=partner/partner',
      'tove=barn/child',
    ]);
    assertEquals(await walk('per', 'svärmor'), ['britt=svärmor/mother-in-law']);
    assertEquals(await walk('karin', 'svåger'), ['sten=svåger/brother-in-law']);

    // A gendered word takes only that gender when anyone of it exists; a person of unknown
    // gender fills in only when nobody else does.
    assertEquals(await walk('olga', 'dotter'), ['eva=dotter/daughter']);
    assertEquals((await walk('per', 'barn')).length, 3);

    const [eva] = await walkKin(ctx, '/p/olga', parseKin('dotter')!);
    assertEquals(eva.born, '2008-03-14');
    assertEquals(eva.gender, 'female');
    assertEquals(eva.name, 'eva');
  } finally {
    await dispose();
  }
});
