/**
 * Categories: settings read defensively from whatever is stored, and `staging category` creating,
 * reading, relabelling and removing one.
 */
import type { StagingCategoryAnswer } from '@archive/staging/api';
import { CATEGORY_ATTR, parseCategorySettings } from '@archive/staging/category';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

Deno.test('settings are read defensively: a missing or empty label is the default one, and other fields are left out', () => {
  assertEquals(parseCategorySettings(undefined, 'old-folder'), { label: 'old-folder' });
  assertEquals(parseCategorySettings(undefined, 'inbox'), { label: 'Inbox' });
  assertEquals(parseCategorySettings('scans', 'x'), { label: 'x' });
  assertEquals(parseCategorySettings({ label: 7 }, 'box-3'), { label: 'box-3' });
  assertEquals(parseCategorySettings({ label: '  ' }, 'box-3'), { label: 'box-3' });
  const stored = {
    kind: 'scans',
    label: 'Box 3',
    destinationId: 'abc',
    group: { strategy: 'none', significance: 'more' },
    time: { digitized: true, filenameDates: false },
    lane: 'bulk',
    sidecars: 'ignore',
  };
  assertEquals(parseCategorySettings(stored, 'box-3'), { label: 'Box 3' });
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

    await t.step('create makes the category and its directory of groups, private', async () => {
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --create --label "Box 3"');
      assertEquals([answer.created, answer.removed, answer.changed], [true, false, []]);
      assertEquals(answer.category?.settings, { label: 'Box 3' });
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category box-4 --create')).category?.label, 'box-4');
      assertEquals(answer.category?.albumsPath, `${ALBUMS}/box-3`);
      for (const path of [`${FILES}/box-3`, `${ALBUMS}/box-3`]) assertEquals((await vfs.get(ADMIN_ACCESS, path)).props.mode & 0o777, 0o700);
    });

    await t.step('a name, a label, a second create or a dry run that does not fit is refused', async () => {
      await cmd.shouldFailWith('staging category Box_3 --create', 'lowercase letters, digits and dashes');
      await cmd.shouldFailWith('staging category box-3 --create', 'already exists');
      await cmd.shouldFailWith("staging category box-5 --create --label ' '", 'a label cannot be empty');
      await cmd.shouldFailWith('staging category box-3 --remove --label Box', '--remove takes no other change');
      await cmd.shouldFailWith('staging category nothing-here', 'no category nothing-here');
      // A setting that is gone is an unknown flag.
      await cmd.shouldFail('staging category box-3 --kind scans');
      // A dry run is a read, so a subcommand that cannot make one refuses it rather than write.
      await cmd.shouldFailWith('staging category box-5 --create --dry-run', '--dry-run is only for init');
    });

    await t.step('without a change it is read, and nothing is written', async () => {
      const before = (await vfs.get(ADMIN_ACCESS, `${FILES}/box-3`)).props.modtime;
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3');
      assertEquals([answer.created, answer.changed, answer.category?.label], [false, [], 'Box 3']);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${FILES}/box-3`)).props.modtime, before);
    });

    await t.step('a relabel writes the settings whole, dropping stored fields that are no setting', async () => {
      await vfs.update(ADMIN_ACCESS, `${FILES}/box-3`, { attrs: { [CATEGORY_ATTR]: { kind: 'scans', label: 'Box 3', lane: 'bulk' } } });
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category box-3 --label "Box 3"')).changed, []);
      const answer = await client.execJson<StagingCategoryAnswer>('staging category box-3 --label "Box three"');
      assertEquals([answer.changed, answer.category?.settings, answer.category?.label], [['label'], { label: 'Box three' }, 'Box three']);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${FILES}/box-3`)).attrs[CATEGORY_ATTR], { label: 'Box three' });
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
