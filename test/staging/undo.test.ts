/**
 * `staging undo`: every kind of decision round-trips. After the undo the inbox, its groups and
 * the albums filed into list as before: the same files with the same node ids, sharing and attrs,
 * the same groups with the same members, attrs and covers, and the library album as it was. A
 * group the decision emptied comes back under its own name. A file moved since stays where it is
 * and is reported; a second undo is refused; undo never pins a group.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumAddResult } from '@archive/media/api';
import type { StagingDiscardResult, StagingJournalPage, StagingPromoteResult, StagingUndoResult } from '@archive/staging/api';
import { type AutoAlbumMeta, isUserEdited, memberKeyOf } from '@archive/staging/auto-album';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { type Listed, listing, makeGroup, readMembers, stagePhotos } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/admin/staging';
const BATCH = `${STAGING}/files/inbox/upload-2019-06-14`;
const GROUPS = `${STAGING}/albums/inbox`;

/** A group's listing without its node id, which a group made again does not keep. */
/**
 * A group as listed, but for its id and its matches: matches are weighed again after a filing
 * (and once more by the organizer), not given back by undo.
 */
const withoutId = ({ id: _id, attrs: { stagingMatches: _matches, ...attrs }, ...rest }: Listed) => ({ ...rest, attrs });

Deno.test({ name: 'staging undo', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} ${BATCH}`);
    await cmd.shouldSucceed(`mknode -t album ${ALBUMS_ROOT}/summer --as name='Summer 2019'`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const owner = { uid: home.props.uid, gid: home.props.gid };

    /** The inbox, its groups, each group's members and the library as they list now. */
    const state = async () => ({
      files: await listing(vfs, BATCH),
      groups: (await listing(vfs, GROUPS)).map(withoutId),
      members: Object.fromEntries(
        await Promise.all(
          (await listing(vfs, GROUPS)).map(async (group) => [group.name, (await listing(vfs, `${GROUPS}/${group.name}`)).map(({ name, softlink }) => ({ name, softlink }))]),
        ),
      ),
      library: (await listing(vfs, ALBUMS_ROOT)).map(({ name, id, type }) => ({ name, id, type })),
      summer: (await listing(vfs, `${ALBUMS_ROOT}/summer`)).map(({ name, id }) => ({ name, id })),
    });
    const groupId = async (slug: string) => (await vfs.get(ADMIN_ACCESS, `${GROUPS}/${slug}`)).id;
    const undo = (ids: string[]) => client.execJson<StagingUndoResult>(`staging undo ${ids.join(' ')}`);

    const lake = await stagePhotos(vfs, BATCH, 'lake', 3, owner);
    const pier = await stagePhotos(vfs, BATCH, 'pier', 2, owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-14`, 'Lake weekend', lake, owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-15`, 'Pier', pier, owner);
    // A group sharing a photo with each of the others, whose cover is one of them.
    await makeGroup(vfs, `${GROUPS}/2019-06-16`, 'Shore', [lake[0], pier[0]], owner);

    await t.step('promote --name: the album goes back to being the group, with its id', async () => {
      const before = await state();
      const ids = [await groupId('2019-06-14'), await groupId('2019-06-16')];
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-14 --name 'Lake weekend'`);
      assertEquals(result.moved, 3);
      const undone = await undo([result.journal!]);
      assertEquals([undone.undone, undone.restoredFiles, undone.failed], [[result.journal], 3, []]);
      assertEquals(await state(), before);
      assertEquals([await groupId('2019-06-14'), await groupId('2019-06-16')], ids);
    });

    await t.step('promote --into: files leave the album, and the groups emptied come back', async () => {
      const before = await state();
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-14 2019-06-15 --into ${ALBUMS_ROOT}/summer`);
      assertEquals([result.moved, (await listing(vfs, `${ALBUMS_ROOT}/summer`)).length], [5, 5]);
      await undo([result.journal!]);
      assertEquals(await state(), before);
    });

    await t.step('discard: the batch comes out of the trash, and the groups get their members back', async () => {
      const before = await state();
      const result = await client.execJson<StagingDiscardResult>('staging discard 2019-06-15');
      assertEquals(await client.execJson<unknown[]>('trash list').then((rows) => rows.length), 1);
      const undone = await undo([result.journal!]);
      assertEquals(undone.restoredFiles, 2);
      assertEquals(await state(), before);
      assertEquals(await client.execJson<unknown[]>('trash list'), []);
    });

    await t.step('album add --create: the files go back and the album it made goes', async () => {
      const before = await state();
      const result = await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/picnic ${pier[1]} ${lake[2]} --create --name 'Lake picnic'`);
      assertEquals([result.created, result.moved.length, result.journal?.length], [true, 2, 1]);
      await undo(result.journal!);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/picnic`), false);
      assertEquals(await state(), before);
    });

    await t.step('undo never pins: every group keeps a key that matches its members', async () => {
      for (const group of await listing(vfs, GROUPS)) {
        const node = await vfs.get<{ name?: string; autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${GROUPS}/${group.name}`);
        const members = await readMembers(vfs, `${GROUPS}/${group.name}`);
        const ids = await Promise.all(members.map(async (path) => (await vfs.get(ADMIN_ACCESS, path)).id));
        assertEquals([node.attrs.autoAlbum.memberKey, node.attrs.autoAlbum.pinned], [memberKeyOf(ids), undefined]);
        assertEquals(isUserEdited(node.attrs, ids), false);
      }
    });

    await t.step('a second undo is refused', async () => {
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-15 --into ${ALBUMS_ROOT}/summer`);
      await undo([result.journal!]);
      await cmd.shouldFailWith(`staging undo ${result.journal}`, 'undone already');
      const page = await client.execJson<StagingJournalPage>('staging journal inbox');
      const entry = page.entries.find((each) => each.id === result.journal)!;
      assertEquals([entry.undoable, typeof entry.undoneAt], [false, 'string']);
    });

    await t.step('a file moved since stays where it is, and the rest come back', async () => {
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-15 --into ${ALBUMS_ROOT}/summer`);
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/elsewhere && mv ${ALBUMS_ROOT}/summer/pier-0.jpg ${ALBUMS_ROOT}/elsewhere/pier-0.jpg`);
      const undone = await undo([result.journal!]);
      assertEquals(undone.undone, [result.journal]);
      assertEquals(undone.restoredFiles, 1);
      assertEquals(undone.failed, [{ id: result.journal!, reason: 'some files have moved since, and stay where they are', files: [`${ALBUMS_ROOT}/elsewhere/pier-0.jpg`] }]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, pier[1]), true);
      // The groups get back only the member that came back.
      assertEquals(await readMembers(vfs, `${GROUPS}/2019-06-15`), [pier[1]]);
      assertEquals(await readMembers(vfs, `${GROUPS}/2019-06-16`), [lake[0]]);
    });

    await t.step('totals leave out what was undone', async () => {
      const page = await client.execJson<StagingJournalPage>('staging journal inbox');
      assertEquals(page.totals, { filed: 0, discarded: 0 });
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
