/**
 * Categories: each kind's preset, settings read defensively from whatever is stored, and
 * `staging category` creating, reading, changing and removing one; a change of its time rules
 * dates its files again.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { StagingCategoryAnswer } from '@archive/staging/api';
import { parseCategorySettings, presetSettings } from '@archive/staging/category';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const EVENTS = { strategy: 'events', significance: 'normal' } as const;
const FOLDERS = { strategy: 'folders', significance: 'normal' } as const;
const CLOCKS = { digitized: false, filenameDates: false };
const NAMES = { digitized: false, filenameDates: true };
const DIGITIZED = { digitized: true, filenameDates: false };

Deno.test('a category of each kind starts from its preset; a generic one is labelled by its name', () => {
  // A messenger's and a screenshot tool's files come with no sidecars to pair.
  assertEquals(presetSettings('messaging', 'whatsapp').sidecars, 'ignore');
  assertEquals(presetSettings('screenshots', 'screens').sidecars, 'ignore');
  assertEquals(presetSettings('inbox', 'inbox'), { kind: 'inbox', label: 'Inbox', group: EVENTS, time: NAMES, lane: 'normal', sidecars: 'pair' });
  assertEquals(presetSettings('google-photos', 'takeout'), { kind: 'google-photos', label: 'Google Photos', group: EVENTS, time: CLOCKS, lane: 'bulk', sidecars: 'pair' });
  assertEquals(presetSettings('generic', 'box-3'), { kind: 'generic', label: 'box-3', group: EVENTS, time: CLOCKS, lane: 'normal', sidecars: 'pair' });
  // Scans are grouped by folder, messages and screenshots into monthly lanes.
  assertEquals(presetSettings('scans', 'box-3').group, FOLDERS);
  assertEquals([presetSettings('messaging', 'chat').group.strategy, presetSettings('screenshots', 'shots').group.strategy], ['none', 'none']);
  // No clock of a scanner dates a scan; phones', messengers' and screenshot tools' names are dates.
  assertEquals(presetSettings('scans', 'box-3').time, DIGITIZED);
  assertEquals((['phone', 'messaging', 'screenshots'] as const).map((kind) => presetSettings(kind, kind).time), [NAMES, NAMES, NAMES]);
  assertEquals(presetSettings('camera', 'camera').time, CLOCKS);
});

Deno.test("settings are read defensively: what is missing or wrong is the kind's preset", () => {
  assertEquals(parseCategorySettings(undefined, 'old-folder'), { kind: 'generic', label: 'old-folder', group: EVENTS, time: CLOCKS, lane: 'normal', sidecars: 'pair' });
  assertEquals(parseCategorySettings({ kind: 'scans' }, 'box-3'), { kind: 'scans', label: 'Scans', group: FOLDERS, time: DIGITIZED, lane: 'bulk', sidecars: 'pair' });
  assertEquals(parseCategorySettings({ kind: 'polaroids', label: 7, destinationId: '' }, 'box-3'), {
    kind: 'generic',
    label: 'box-3',
    group: EVENTS,
    time: CLOCKS,
    lane: 'normal',
    sidecars: 'pair',
  });
  assertEquals(parseCategorySettings({ kind: 'phone', label: 'Anna’s phone', destinationId: 'abc' }, 'phone'), {
    kind: 'phone',
    label: 'Anna’s phone',
    destinationId: 'abc',
    group: EVENTS,
    time: NAMES,
    lane: 'normal',
    sidecars: 'pair',
  });
  assertEquals(parseCategorySettings('scans', 'x'), { kind: 'generic', label: 'x', group: EVENTS, time: CLOCKS, lane: 'normal', sidecars: 'pair' });
  // So are the time rules.
  assertEquals(parseCategorySettings({ kind: 'scans', time: { digitized: false, filenameDates: 'yes' } }, 'box-3').time, CLOCKS);
  assertEquals(parseCategorySettings({ kind: 'inbox', time: 'none' }, 'inbox').time, NAMES);
  // So is whether sidecars are paired.
  assertEquals(parseCategorySettings({ kind: 'phone', sidecars: 'never' }, 'phone').sidecars, 'pair');
  assertEquals(parseCategorySettings({ kind: 'phone', sidecars: 'ignore' }, 'phone').sidecars, 'ignore');
  // A stored group setting is taken field by field.
  assertEquals(parseCategorySettings({ kind: 'phone', group: { strategy: 'none', significance: 'loud' } }, 'phone').group, { strategy: 'none', significance: 'normal' });
  assertEquals(parseCategorySettings({ kind: 'phone', group: 'more' }, 'phone').group, EVENTS);
});

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'staging category', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const FILES = '/home/admin/staging/files';
  const ALBUMS = '/home/admin/staging/albums';
  try {
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && mknode -t album ${ALBUMS_ROOT}/prints`);
    const prints = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/prints`)).id;

    await t.step('create makes the category and its directory of groups, private', async () => {
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --create --kind scans --label "Box 3"');
      assertEquals([answer.created, answer.removed, answer.changed], [true, false, []]);
      assertEquals(answer.category?.settings, { kind: 'scans', label: 'Box 3', group: FOLDERS, time: DIGITIZED, lane: 'bulk', sidecars: 'pair' });
      assertEquals(answer.retime, null);
      assertEquals(answer.category?.albumsPath, `${ALBUMS}/box-3`);
      for (const path of [`${FILES}/box-3`, `${ALBUMS}/box-3`]) assertEquals((await vfs.get(ADMIN_ACCESS, path)).props.mode & 0o777, 0o700);
    });

    await t.step('a name, a kind, a second create or a dry run that does not fit is refused', async () => {
      await cmd.shouldFailWith('staging category Box_3 --create', 'lowercase letters, digits and dashes');
      await cmd.shouldFailWith('staging category box-3 --create', 'already exists');
      await cmd.shouldFailWith('staging category box-4 --create --kind polaroids', "unknown kind 'polaroids'");
      await cmd.shouldFailWith('staging category box-4 --create --kind inbox', 'only the default category');
      await cmd.shouldFailWith('staging category inbox --kind scans', 'the default category inbox is of the inbox kind');
      await cmd.shouldFailWith('staging category nothing-here', 'no category nothing-here');
      // A dry run is a read, so a subcommand that cannot make one refuses it rather than write.
      await cmd.shouldFailWith('staging category box-4 --create --dry-run', '--dry-run is only for init');
    });

    await t.step('without a change it is read, and nothing is written', async () => {
      const before = (await vfs.get(ADMIN_ACCESS, `${FILES}/box-3`)).props.modtime;
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3');
      assertEquals([answer.created, answer.changed, answer.category?.label], [false, [], 'Box 3']);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${FILES}/box-3`)).props.modtime, before);
    });

    await t.step('label and destination change; a kind resets the label to its preset but keeps the destination', async () => {
      let answer = await client.execJson<StagingCategoryAnswer>(`staging category box-3 --label "Box three" --destination ${ALBUMS_ROOT}/prints`);
      assertEquals(answer.changed, ['label', 'destinationId']);
      assertEquals(answer.category?.settings, { kind: 'scans', label: 'Box three', destinationId: prints, group: FOLDERS, time: DIGITIZED, lane: 'bulk', sidecars: 'pair' });
      assertEquals(answer.category?.destination?.path, `${ALBUMS_ROOT}/prints`);
      assertEquals(answer.retime, null);

      answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --kind camera');
      assertEquals(answer.category?.settings, { kind: 'camera', label: 'Camera', destinationId: prints, group: EVENTS, time: CLOCKS, lane: 'normal', sidecars: 'pair' });
      assertEquals([answer.changed.includes('time'), answer.retime?.path, answer.retime?.scanned], [true, `${FILES}/box-3`, 0]);

      answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --no-destination');
      assertEquals([answer.changed, answer.category?.destination], [['destinationId'], null]);
      await cmd.shouldFailWith(`staging category box-3 --destination ${FILES}/inbox`, 'a destination is a library album');
    });

    await t.step('how its files are grouped changes, and an unknown value is refused', async () => {
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --strategy none --significance more');
      assertEquals([answer.changed, answer.category?.settings.group], [['group'], { strategy: 'none', significance: 'more' }]);
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category box-3 --significance more')).changed, []);
      await cmd.shouldFailWith('staging category box-3 --strategy albums', "unknown strategy 'albums'");
      await cmd.shouldFailWith('staging category box-3 --significance loud', "unknown significance 'loud'");
    });

    await t.step('whether its sidecars are paired changes, and an unknown value is refused', async () => {
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --sidecars ignore');
      assertEquals([answer.changed, answer.category?.settings.sidecars, answer.retime], [['sidecars'], 'ignore', null]);
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category box-3 --sidecars pair')).changed, ['sidecars']);
      await cmd.shouldFailWith('staging category box-3 --sidecars always', "unknown sidecars 'always'");
    });

    await t.step('its time rules change one by one, and its files are dated again by them', async () => {
      await cmd.shouldSucceed(`mkdir -p ${FILES}/box-3/folder && mknode -t file ${FILES}/box-3/folder/IMG_20190601_123456.jpg --as mimetype=image/jpeg --as size=10`);
      let answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --filename-dates on');
      assertEquals([answer.changed, answer.category?.settings.time], [['time'], NAMES]);
      assertEquals([answer.retime?.scanned, answer.retime?.policyChanged, answer.retime?.bySource], [1, 1, { name: 1 }]);
      const file = await vfs.get(ADMIN_ACCESS, `${FILES}/box-3/folder/IMG_20190601_123456.jpg`);
      assertEquals([file.attrs.whenName, file.attrs.takenAtSource], ['2019-06-01T12:34:56', 'name']);

      answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --digitized on');
      assertEquals([answer.changed, answer.category?.settings.time], [['time'], { digitized: true, filenameDates: true }]);
      assertEquals([answer.retime?.retimed, answer.retime?.cleared], [1, 1]);
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category box-3 --digitized on')).retime, null);
      await cmd.shouldFailWith('staging category box-3 --digitized maybe', '--digitized is on or off');
      await cmd.shouldSucceed(`rm ${FILES}/box-3/folder/IMG_20190601_123456.jpg`);
    });

    await t.step('remove takes only an empty category, and never the default one', async () => {
      await cmd.shouldSucceed(`mkdir -p ${FILES}/box-3/folder && mknode -t file ${FILES}/box-3/folder/scan.tif`);
      await cmd.shouldFailWith('staging category box-3 --remove', 'is not empty');
      await cmd.shouldSucceed(`rm ${FILES}/box-3/folder/scan.tif`);
      // Organized once, it has the organizer's checkpoint among its groups, which is no group.
      await cmd.shouldSucceed('staging organize box-3');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS}/box-3/.organizer`), true);
      await cmd.shouldFailWith('staging category inbox --remove', 'cannot be removed');
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --remove');
      assertEquals([answer.removed, answer.category], [true, null]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${FILES}/box-3`), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS}/box-3`), false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
