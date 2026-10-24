/**
 * The decisions as the inbox's owner makes them, not an administrator: Anna Andersson promotes,
 * puts aside, discards and files her own organizer-made groups, lists her journal and undoes each
 * decision. A promote that fails part-way leaves a `partial` entry that undoes what it did.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumAddResult } from '@archive/media/api';
import type { StagingDiscardResult, StagingJournalPage, StagingLaterResult, StagingPromoteResult, StagingUndoResult } from '@archive/staging/api';
import { type AutoAlbumMeta, memberKeyOf } from '@archive/staging/auto-album';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { listing, makeGroup, readMembers, stagePhotos } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/anna/staging';
const BATCH = `${STAGING}/files/inbox/upload-2019-06-14`;
const GROUPS = `${STAGING}/albums/inbox`;

Deno.test({ name: 'the inbox owner decides and undoes', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin: ShellClient = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];
  const cmd = testCommands(admin);
  try {
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('user-create anna --uid 3400');
    await cmd.shouldSucceed('user-passwd anna --new-password secret1');
    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && chmod 777 ${ALBUMS_ROOT}`);
    const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
    clients.push(anna);
    const asAnna = testCommands(anna);
    await asAnna.shouldSucceed(`mkdir -p ${BATCH}`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/anna');
    const owner = { uid: home.props.uid, gid: home.props.gid };
    const undo = (id: string) => anna.execJson<StagingUndoResult>(`staging undo ${id}`);

    const lake = await stagePhotos(vfs, BATCH, 'lake', 3, owner);
    const pier = await stagePhotos(vfs, BATCH, 'pier', 2, owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-14`, 'Lake weekend', lake, owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-15`, 'Pier', pier, owner);

    await t.step('she promotes a group into a new album, and undoes it', async () => {
      const before = await listing(vfs, BATCH);
      const result = await anna.execJson<StagingPromoteResult>(`staging promote 2019-06-14 --name 'Lake weekend'`);
      assertEquals([result.moved, result.failed], [3, []]);
      const album = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/Lake weekend`);
      assertEquals(album.props.uid, 3400);
      const undone = await undo(result.journal!);
      assertEquals(undone.restoredFiles, 3);
      assertEquals(await listing(vfs, BATCH), before);
      const group = await vfs.get(ADMIN_ACCESS, `${GROUPS}/2019-06-14`);
      assertEquals([group.props.uid, group.props.gid, group.props.mode & 0o777], [3400, home.props.gid, 0o700]);
    });

    await t.step('she puts a group aside and brings it back', async () => {
      assertEquals((await anna.execJson<StagingLaterResult>('staging later 2019-06-15')).later, true);
      assertEquals((await anna.execJson<StagingLaterResult>('staging later 2019-06-15 --off')).later, false);
    });

    await t.step('she discards into her own trash, and undoes it', async () => {
      const result = await anna.execJson<StagingDiscardResult>('staging discard 2019-06-15');
      assertEquals(result.files, 2);
      assertEquals((await anna.execJson<{ id: string }[]>('trash list')).map((row) => row.id), result.batches);
      await undo(result.journal!);
      assertEquals(await readMembers(vfs, `${GROUPS}/2019-06-15`), pier);
    });

    await t.step('she files a staged photo with album add, and undoes it', async () => {
      const result = await anna.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/Lake ${lake[1]} --create --name Lake`);
      assertEquals(result.moved.length, 1);
      await anna.execJson<StagingUndoResult>(`staging undo ${result.journal!.join(' ')}`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, lake[1]), true);
    });

    await t.step('a promote that fails part-way is partial, and its undo puts back what moved', async () => {
      // Two of the members are in a folder she cannot take anything out of.
      const stuck = `${STAGING}/files/inbox/stuck`;
      await asAnna.shouldSucceed(`mkdir -p ${stuck}`);
      const held = await stagePhotos(vfs, stuck, 'held', 2, owner);
      await asAnna.shouldSucceed(`chmod 500 ${stuck}`);
      await makeGroup(vfs, `${GROUPS}/2019-06-16`, 'Mixed', [...held, lake[0]], owner);

      const promoted = await anna.exec(`staging promote 2019-06-16 --name Mixed`);
      assertEquals(promoted.success, false);
      const [entry] = (await anna.execJson<StagingJournalPage>('staging journal inbox')).entries;
      assertEquals([entry.action, entry.state, entry.files], ['promote', 'partial', 3]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, lake[0]), false);

      const undone = await undo(entry.id);
      assertEquals([undone.undone, undone.restoredFiles, undone.failed], [[entry.id], 1, []]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, lake[0]), true);
      const meta = (await vfs.get<{ autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${GROUPS}/2019-06-16`)).attrs.autoAlbum;
      const members = await readMembers(vfs, `${GROUPS}/2019-06-16`);
      assertEquals(members.sort(), [...held, lake[0]].sort());
      assertEquals(meta.memberKey, memberKeyOf(await Promise.all(members.map(async (path) => (await vfs.get(ADMIN_ACCESS, path)).id))));
      assertEquals(meta.pinned, undefined);
    });

    await t.step("she cannot decide or read another inbox's journal", async () => {
      await asAnna.shouldFailWith('staging journal --user admin', "cannot access staging for 'admin'");
      await asAnna.shouldFail('staging promote /home/admin/staging/albums/inbox/2019-06-14');
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
