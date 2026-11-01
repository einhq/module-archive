/**
 * gedcom-import against the archive: a staged file is kept in /archive/sources/genealogy,
 * its individuals are found among the people or made, the relations it gives are added, and every
 * person it describes links it, and their events, homes and notes are added where they lack them.
 * A dry run writes nothing; the same file again adds nothing; a merged person's links follow them.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { GENEALOGY_SOURCES, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { GedcomImportResult, PersonInfo } from '@archive/people/api';
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
