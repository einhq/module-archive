/**
 * gedcom-import against the archive: a staged file is kept in /archive/sources/genealogy,
 * its individuals are found among the people or made, the relations it gives are added, and every
 * person it describes links it, and their events, homes and notes are added where they lack them.
 * A dry run writes nothing; the same file again adds nothing; a merged person's links follow them.
 * A file staged by the pipeline waits in genealogy/ until it is imported, and who its individuals
 * are can be chosen before.
 */

import { assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { GENEALOGY_SOURCES, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { GedcomImportResult, GedcomPlan, GedcomStageResult, PersonInfo, PersonTimeline } from '@archive/people/api';
import type { StagingStatus } from '@archive/staging/api';
import type { SourceFile } from '@archive/sources/api';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

/** Harold again, with what happened to him and where, and a second partner. */
const STORY = `0 HEAD
0 @I1@ INDI
1 NAME Harold /Wrenfield/
1 BIRT
2 DATE 3 MAR 1931
2 PLAC Lower Wrenfield, Kent
1 OCCU Boatbuilder
2 DATE FROM 1950 TO 1975
1 RESI
2 DATE FROM 1960 TO 1980
2 PLAC Mill House, Lower Wrenfield
1 RESI
2 DATE 1985
2 PLAC Somewhere Else
1 NOTE Kept a boatyard
2 CONT by the river.
1 FAMS @F1@
0 @I5@ INDI
1 NAME Edith /Marsh/
1 SEX F
1 NOTE @N1@
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I5@
1 MARR
2 DATE 1990
2 PLAC Saint Ann's
0 @N1@ NOTE Played the organ.
0 TRLR
`;

/** A couple the file knows only roughly when about. */
const ROUGH = `0 HEAD
0 @I1@ INDI
1 NAME Clara /Pole/
1 SEX F
1 BIRT
2 DATE ABT 1890
1 DEAT
2 DATE BEF 1960
1 OCCU Seamstress
2 DATE ABT 1910
1 CENS
2 DATE AFT 1920
1 FAMS @F1@
0 @I2@ INDI
1 NAME Walter /Pole/
1 SEX M
1 BIRT
2 DATE BET 1885 AND 1889
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
1 MARR
2 DATE ABT 1912
0 TRLR
`;

const TREE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Harold /Wrenfield/
1 SEX M
1 BIRT
2 DATE 3 MAR 1931
1 FAMS @F1@
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

/** Harold again, with two daughters: one the archive has under another name, one it should not get. */
const FAMILY = `0 HEAD
0 @I1@ INDI
1 NAME Harold /Wrenfield/
1 BIRT
2 DATE 3 MAR 1931
1 FAMS @F1@
0 @I2@ INDI
1 NAME Rosie /Wrenfield/
1 FAMC @F1@
0 @I3@ INDI
1 NAME Clara /Wrenfield/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
1 CHIL @I3@
`;

Deno.test({
  name: 'gedcom-import',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const inbox = '/home/admin/staging/files/inbox/upload-2026-11-01';
  const stage = async (name: string, text: string): Promise<string> => {
    const path = `${inbox}/${name}`;
    await cmd.shouldSucceed(`mkfile ${path}`);
    const fh = await ctx.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await fh.write(new TextEncoder().encode(text));
    } finally {
      await fh.close();
    }
    return path;
  };
  const info = (slug: string) => client.execJson<PersonInfo>(`person-info ${PEOPLE_ROOT}/${slug}`);

  try {
    await cmd.shouldSucceed(`staging init --user admin && mkdir -p ${inbox}`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/harold --name 'Harold Wrenfield' --born 1931-03-03`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/ruby --name Ruby`);
    await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/ruby ${PEOPLE_ROOT}/harold`);

    await t.step('a dry run says who is who and writes nothing', async () => {
      const staged = await stage('tree.ged', TREE);
      const plan = await client.execJson<GedcomImportResult>(`gedcom-import ${staged} --dry-run`);
      assertEquals(plan.dryRun, true);
      assertEquals(plan.matched.map((m) => [m.xref, m.person, m.how]), [['@I1@', `${PEOPLE_ROOT}/harold`, 'name-date'], ['@I3@', `${PEOPLE_ROOT}/ruby`, 'relatives']]);
      assertEquals(plan.created.map((c) => [c.xref, c.name]), [['@I2@', 'Ann Wrenfield'], ['@I4@', 'Tom Wrenfield']]);
      assertEquals([plan.parents, plan.partners], [3, 1]);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, staged), true);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/ann-wrenfield`), false);
    });

    await t.step('the import keeps the file, matches, makes, relates and links', async () => {
      const result = await client.execJson<GedcomImportResult>(`gedcom-import ${inbox}/tree.ged`);
      const kept = `${GENEALOGY_SOURCES}/tree.ged`;
      assertEquals(result.source, kept);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, `${inbox}/tree.ged`), false);
      assertEquals((await ctx.vfs.get(ADMIN_ACCESS, kept)).attrs.mimetype, 'application/x-gedcom');
      assertEquals(result.created.map((c) => c.person), [`${PEOPLE_ROOT}/ann-wrenfield`, `${PEOPLE_ROOT}/tom-wrenfield`]);

      // Ruby had only a first name: what the file adds fills in, and nothing she had is changed.
      const ruby = await info('ruby');
      assertEquals([ruby.name, ruby.fullname, ruby.born, ruby.gender], ['Ruby', 'Ruby Wrenfield', '1962-06-12', 'female']);
      assertEquals(ruby.relations.filter((r) => r.role !== 'partner').map((r) => r.path).sort(), [`${PEOPLE_ROOT}/ann-wrenfield`, `${PEOPLE_ROOT}/harold`]);
      assertEquals(ruby.sources.map((s) => [s.name, s.path, s.xref]), [['tree.ged', kept, '@I3@']]);

      const ann = await info('ann-wrenfield');
      assertEquals([ann.fullname, ann.birthname, ann.born], ['Margaret Ann Wrenfield', 'Margaret Ann Pole', '1934']);
      const partner = ann.relations.find((r) => r.role === 'partner');
      assertEquals([partner?.path, partner?.kind, partner?.from], [`${PEOPLE_ROOT}/harold`, 'married', '1958-08-20']);

      const tom = await info('tom-wrenfield');
      assertEquals(tom.relations.map((r) => [r.path, r.kind]).sort(), [[`${PEOPLE_ROOT}/ann-wrenfield`, 'adoptive'], [`${PEOPLE_ROOT}/harold`, 'adoptive']]);

      const listed = await client.execJson<SourceFile[]>(`source-list ${PEOPLE_ROOT}/harold`);
      assertEquals(listed.map((s) => [s.path, s.xref, s.mimetype]), [[kept, '@I1@', 'application/x-gedcom']]);
    });

    await t.step('the same file again finds the same people and adds nothing', async () => {
      const staged = await stage('tree-again.ged', TREE);
      const again = await client.execJson<GedcomImportResult>(`gedcom-import ${staged}`);
      assertEquals(again.source, `${GENEALOGY_SOURCES}/tree.ged`);
      assertEquals(again.matched.map((m) => m.how), ['source', 'source', 'source', 'source']);
      assertEquals([again.created.length, again.parents, again.partners], [0, 0, 0]);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, staged), false);
      assertEquals((await ctx.vfs.children(ADMIN_ACCESS, GENEALOGY_SOURCES)).map((e) => e.name), ['tree.ged']);
    });

    await t.step("a merged person's sources follow them", async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/thomas --name 'Thomas Wrenfield'`);
      await cmd.shouldSucceed(`person-merge ${PEOPLE_ROOT}/tom-wrenfield ${PEOPLE_ROOT}/thomas`);
      assertEquals((await info('thomas')).sources.map((s) => s.xref), ['@I4@']);
    });

    await t.step('events, homes and notes are added where they are missing, once', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/lower-wrenfield --as 'name=Lower Wrenfield'`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/lower-wrenfield/position --lat=51.2 --lng=0.5`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/mill-house --as 'name=Mill House'`);
      await cmd.shouldSucceed(`person-update ${PEOPLE_ROOT}/harold --description 'Ran the boatyard.'`);

      const plan = await client.execJson<GedcomImportResult>(`gedcom-import ${await stage('story.ged', STORY)} --dry-run`);
      assertEquals([plan.events, plan.homes], [4, 1]);

      const result = await client.execJson<GedcomImportResult>(`gedcom-import ${inbox}/story.ged`);
      assertEquals(result.matched.map((m) => [m.xref, m.person]), [['@I1@', `${PEOPLE_ROOT}/harold`]]);
      assertEquals([result.events, result.homes, result.skipped], [4, 1, []]);

      const harold = await info('harold');
      // His own description stays; Edith, made now, has her note as hers.
      assertEquals(harold.description, 'Ran the boatyard.');
      assertEquals(harold.events.map((e) => [e.eventType, e.name, e.date, e.position, e.description]).sort(), [
        ['birth', 'Birth', '1931-03-03', 'geo', 'Lower Wrenfield, Kent'],
        ['generic', 'Occupation: Boatbuilder', '1950', undefined, undefined],
        ['generic', 'Residence', '1985', undefined, 'Somewhere Else'],
        ['marriage', 'Marriage', '1990', undefined, "Saint Ann's"],
      ]);
      assertEquals(harold.homes.map((h) => [h.path, h.from, h.to]), [[`${LOCATIONS_ROOT}/mill-house`, '1960', '1980']]);
      assertEquals((await info('edith-marsh')).description, 'Played the organ.');

      const again = await client.execJson<GedcomImportResult>(`gedcom-import ${await stage('story-again.ged', STORY)}`);
      assertEquals([again.events, again.homes, again.partners], [0, 0, 0]);
      assertEquals((await info('harold')).events.length, 4);
    });

    await t.step('an approximate date is kept with how sure it is', async () => {
      const result = await client.execJson<GedcomImportResult>(`gedcom-import ${await stage('rough.ged', ROUGH)}`);
      assertEquals(result.created.map((c) => c.person), [`${PEOPLE_ROOT}/clara-pole`, `${PEOPLE_ROOT}/walter-pole`]);
      // Occupation and census for Clara; the marriage, which the relation cannot date, on Walter.
      assertEquals(result.events, 3);

      const clara = await info('clara-pole');
      // Died only before a year: no age to give.
      assertEquals([clara.born, clara.bornQualifier, clara.died, clara.diedQualifier, clara.age], ['1890', 'about', '1960', 'before', undefined]);
      assertEquals((await info('walter-pole')).age?.approx, true);
      assertEquals(clara.events.map((e) => [e.name, e.date, e.dateQualifier]).sort(), [['Census', '1920', 'after'], ['Occupation: Seamstress', '1910', 'about']]);
      const walter = await info('walter-pole');
      assertEquals([walter.born, walter.bornQualifier], ['1887', 'about']);
      assertEquals(walter.events.map((e) => [e.eventType, e.date, e.dateQualifier]), [['marriage', '1912', 'about']]);
      assertEquals(walter.relations.find((r) => r.role === 'partner')?.from, undefined);

      const timeline = await client.execJson<PersonTimeline>(`person-timeline ${PEOPLE_ROOT}/clara-pole`);
      const life = timeline.entries.filter((e) => e.kind === 'birth' || e.kind === 'death').map((e) => [e.kind, e.date, e.dateQualifier]);
      assertEquals(life.sort(), [['birth', '1890', 'about'], ['death', '1960', 'before']]);

      const again = await client.execJson<GedcomImportResult>(`gedcom-import ${await stage('rough-again.ged', ROUGH)}`);
      assertEquals([again.created.length, again.events], [0, 0]);
    });

    await t.step('a staged file is imported as its owner, who may change only their own people', async () => {
      await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
      await cmd.shouldSucceed('user-create anna --uid 3400 && staging init --user anna && mkdir -p /home/anna/staging/files/inbox/upload-2026-11-01');
      const staged = '/home/anna/staging/files/inbox/upload-2026-11-01/lily.ged';
      await cmd.shouldSucceed(`mkfile ${staged}`);
      const fh = await ctx.vfs.open(ADMIN_ACCESS, staged, { mode: 'w' });
      try {
        await fh.write(new TextEncoder().encode(`0 HEAD
0 @I1@ INDI
1 NAME Harold /Wrenfield/
1 BIRT
2 DATE 3 MAR 1931
1 FAMS @F1@
0 @I9@ INDI
1 NAME Lily /Wrenfield/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I9@
`));
      } finally {
        await fh.close();
      }
      await cmd.shouldSucceed(`chown 3400 /home/anna/staging/files/inbox/upload-2026-11-01 ${staged}`);

      // Harold is the administrator's alone: anna may read him, not change him.
      await cmd.shouldSucceed(`chmod 755 ${PEOPLE_ROOT}/harold`);
      // Run as the pipeline runs it, with administrative access.
      const result = await client.execJson<GedcomImportResult>(`gedcom-import ${staged}`);
      assertEquals(result.matched.map((m) => m.person), [`${PEOPLE_ROOT}/harold`]);
      assertEquals(result.created.map((c) => c.person), [`${PEOPLE_ROOT}/lily-wrenfield`]);
      assertEquals(result.parents, 0);
      assertEquals(result.skipped.map((s) => s.reason), [
        `may not change ${PEOPLE_ROOT}/harold`,
        `may not change ${PEOPLE_ROOT}/harold, not relating ${PEOPLE_ROOT}/lily-wrenfield`,
      ]);
      assertEquals((await ctx.vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/lily-wrenfield`)).props.uid, 3400);
      assertEquals((await info('lily-wrenfield')).sources.map((s) => s.path), [`${GENEALOGY_SOURCES}/lily.ged`]);
      assertEquals((await info('harold')).sources.map((s) => s.name).sort(), ['story.ged', 'tree.ged']);
    });

    await t.step('a file outside staging is copied without what was read out of it', async () => {
      const home = '/home/admin/lily-copy.ged';
      await cmd.shouldSucceed(`mkfile ${home}`);
      const fh = await ctx.vfs.open(ADMIN_ACCESS, home, { mode: 'w' });
      try {
        await fh.write(new TextEncoder().encode('0 HEAD\n0 @I1@ INDI\n1 NAME Lily /Wrenfield/\n'));
      } finally {
        await fh.close();
      }
      // As the text pipeline leaves it.
      await cmd.shouldSucceed(`mkdir ${home}/metadata`);

      const result = await client.execJson<GedcomImportResult>(`gedcom-import ${home}`);
      assertEquals(result.source, `${GENEALOGY_SOURCES}/lily-copy.ged`);
      assertEquals((await ctx.vfs.children(ADMIN_ACCESS, result.source)).length, 0);
      assertEquals((await ctx.vfs.children(ADMIN_ACCESS, home)).map((e) => e.name), ['metadata']);
      const again = await client.execJson<GedcomImportResult>(`gedcom-import ${home}`);
      assertEquals(again.source, result.source);
    });

    await t.step('a staged file waits in genealogy/, read with choices, and is imported as chosen', async () => {
      const staged = await stage('family.ged', FAMILY);
      const waiting = await client.execJson<GedcomStageResult>(`gedcom-stage ${staged}`);
      assertEquals(waiting, { path: '/home/admin/staging/genealogy/family.ged', individuals: 3, families: 1 });
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, staged), false);
      assertEquals((await ctx.vfs.get(ADMIN_ACCESS, waiting.path)).attrs.mimetype, 'application/x-gedcom');
      assertEquals((await client.execJson<StagingStatus>('staging status')).genealogyWaiting, 1);

      // Of a like name, with a word the file does not have: suggested for Clara, never taken.
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/clara-c --name 'Clara Cee Wrenfield'`);
      // Spelled another way, by the archive's rules (Klara) and by the administrator's own (Rose).
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/klara --name 'Klara Wrenfield' && person-create ${PEOPLE_ROOT}/rose --name 'Rose Wrenfield'`);
      // The module's rules as `mod setup` links them, which the harness does not.
      await cmd.shouldSucceed('mkdir -p /etc/name-spellings.d/archive && mkfile /etc/name-spellings.d/archive/spellings');
      const rules = await ctx.vfs.open(ADMIN_ACCESS, '/etc/name-spellings.d/archive/spellings', { mode: 'w' });
      try {
        await rules.write(await Deno.readFile(fromFileUrl(new URL('../../etc/name-spellings.d/spellings', import.meta.url))));
      } finally {
        await rules.close();
      }
      await cmd.shouldSucceed("echo 'ie$ -> e' > /etc/name-spellings.d/local");
      const plan = await client.execJson<GedcomPlan>(`gedcom-read ${waiting.path}`);
      assertEquals(plan.individuals[2].candidates, [
        { person: `${PEOPLE_ROOT}/clara-c`, score: 3, loose: true },
        { person: `${PEOPLE_ROOT}/klara`, score: 3, loose: true },
      ]);
      assertEquals(plan.individuals[1].candidates, [{ person: `${PEOPLE_ROOT}/rose`, score: 3, loose: true }]);
      assertEquals(plan.individuals.map((i) => [i.xref, i.action, i.person, i.how, i.chosen]), [
        ['@I1@', 'match', `${PEOPLE_ROOT}/harold`, 'name-date', false],
        ['@I2@', 'new', undefined, undefined, false],
        ['@I3@', 'new', undefined, undefined, false],
      ]);
      assertEquals([plan.individuals[1].parents, plan.individuals[0].children], [['@I1@'], ['@I2@', '@I3@']]);
      // Harold's own family in the archive comes along, to be drawn beside the file's.
      assertEquals(plan.people[`${PEOPLE_ROOT}/harold`].children.includes(`${PEOPLE_ROOT}/ruby`), true);
      assertEquals(plan.people[`${PEOPLE_ROOT}/ruby`].name, 'Ruby');

      const chosen = await client.execJson<GedcomPlan>(`gedcom-read ${waiting.path} --match I2=ruby`);
      assertEquals([chosen.individuals[1].action, chosen.individuals[1].person, chosen.individuals[1].how], ['match', `${PEOPLE_ROOT}/ruby`, 'chosen']);

      await cmd.shouldFailWith(`gedcom-read ${waiting.path} --match @I9@=ruby`, 'the file has no individual @I9@');
      await cmd.shouldFailWith(`gedcom-read ${waiting.path} --match @I2@=nobody`, `${PEOPLE_ROOT}/nobody is not a person`);
      await cmd.shouldFailWith(`gedcom-import ${waiting.path} --match @I2@=ruby --match @I3@=ruby`, 'is chosen for both @I2@ and @I3@');
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, waiting.path), true);

      const result = await client.execJson<GedcomImportResult>(`gedcom-import ${waiting.path} --match @I2@=ruby --new @I1@ --skip @I3@`);
      assertEquals(result.matched.map((m) => [m.xref, m.person, m.how]), [['@I2@', `${PEOPLE_ROOT}/ruby`, 'chosen']]);
      assertEquals(result.created.map((c) => [c.xref, c.person]), [['@I1@', `${PEOPLE_ROOT}/harold-wrenfield`]]);
      assertEquals(result.skipped.find((s) => s.xref === '@I3@')?.reason, 'left out');
      assertEquals(result.source, `${GENEALOGY_SOURCES}/family.ged`);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/clara-wrenfield`), false);
      assertEquals((await client.execJson<StagingStatus>('staging status')).genealogyWaiting, 0);
    });

    await t.step('a file with no individuals is refused and left where it is', async () => {
      const staged = await stage('notes.ged', 'just some notes\n');
      await cmd.shouldFailWith(`gedcom-import ${staged}`, 'no individuals found');
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, staged), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
