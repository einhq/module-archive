/**
 * The decisions on suggested groups: promote into a new album or an existing one, with members
 * kept back or a group that changed refused; discard; later; accept by the proposal rule; and a
 * move to another category. Each that takes files out of the inbox leaves one journal entry.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { StagingAcceptResult, StagingDiscardResult, StagingJournalPage, StagingLaterResult, StagingMoveResult, StagingPromoteResult } from '@archive/staging/api';
import { type AutoAlbumMeta, memberKeyOf } from '@archive/staging/auto-album';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { listing, makeGroup, readMembers, stagePhotos } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/admin/staging';
const BATCH = `${STAGING}/files/inbox/upload-2019-06-14`;
const GROUPS = `${STAGING}/albums/inbox`;

Deno.test({ name: 'staging decisions', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} ${BATCH}`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const owner = { uid: home.props.uid, gid: home.props.gid };
    const metaOf = async (slug: string) => (await vfs.get<{ autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${GROUPS}/${slug}`)).attrs.autoAlbum;
    const idsOf = (paths: string[]) => Promise.all(paths.map(async (path) => (await vfs.get(ADMIN_ACCESS, path)).id));
    const journal = () => client.execJson<StagingJournalPage>('staging journal inbox --limit 200');

    await t.step('promote --name makes the group itself the album, under its title', async () => {
      const photos = await stagePhotos(vfs, BATCH, 'lake', 3, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-14`, 'Lake weekend', photos, owner);
      const groupId = (await vfs.get(ADMIN_ACCESS, `${GROUPS}/2019-06-14`)).id;
      const key = (await metaOf('2019-06-14')).memberKey;
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-14 --name 'Lake weekend' --expect ${key}`);
      assertEquals(result.album, { path: `${ALBUMS_ROOT}/Lake weekend`, title: 'Lake weekend', created: true });
      assertEquals([result.moved, result.changed, result.failed], [3, [], []]);
      const album = await vfs.get<{ name?: string; origin?: string }>(ADMIN_ACCESS, `${ALBUMS_ROOT}/Lake weekend`);
      assertEquals([album.id, album.attrs.name, album.attrs.origin], [groupId, 'Lake weekend', undefined]);
      assertEquals((await listing(vfs, `${ALBUMS_ROOT}/Lake weekend/files`)).map((entry) => entry.name), ['lake-0.jpg', 'lake-1.jpg', 'lake-2.jpg']);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${GROUPS}/2019-06-14`), false);
      const [entry] = (await journal()).entries;
      assertEquals([entry.id, entry.action, entry.files, entry.state, entry.summary], [result.journal, 'promote', 3, 'done', '3 files → Lake weekend']);
      assertEquals(entry.destination, { path: `${ALBUMS_ROOT}/Lake weekend`, title: 'Lake weekend' });
    });

    await t.step('a title taken in the library is numbered, and a private album is its owner alone', async () => {
      const photos = await stagePhotos(vfs, BATCH, 'cove', 2, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-15`, 'Lake weekend', photos, owner);
      const result = await client.execJson<StagingPromoteResult>('staging promote 2019-06-15 --share private');
      assertEquals(result.album?.path, `${ALBUMS_ROOT}/Lake weekend (2)`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/Lake weekend (2)`)).props.mode & 0o777, 0o700);
      assertEquals((await journal()).entries[0].share, 'private');
    });

    await t.step('promote --into files several groups into an album that is there, and deletes them', async () => {
      await cmd.shouldSucceed(`mknode -t album ${ALBUMS_ROOT}/summer --as name='Summer 2019'`);
      const first = await stagePhotos(vfs, BATCH, 'pier', 2, owner);
      const second = await stagePhotos(vfs, BATCH, 'dune', 2, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-16`, 'Pier', first, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-17`, 'Dunes', second, owner);
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-16 2019-06-17 --into ${ALBUMS_ROOT}/summer`);
      assertEquals(result.album, { path: `${ALBUMS_ROOT}/summer`, title: 'Summer 2019', created: false });
      assertEquals(result.moved, 4);
      assertEquals(result.groupsRemoved.sort(), [`${GROUPS}/2019-06-16`, `${GROUPS}/2019-06-17`]);
      assertEquals((await listing(vfs, `${ALBUMS_ROOT}/summer`)).filter((entry) => entry.type === 'file').length, 4);
      assertEquals((await journal()).entries[0].groups, [{ slug: '2019-06-16', name: 'Pier' }, { slug: '2019-06-17', name: 'Dunes' }]);
    });

    await t.step('--except keeps a member in its group, which is pinned', async () => {
      const photos = await stagePhotos(vfs, BATCH, 'boat', 3, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-18`, 'Boat', photos, owner);
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-18 --into ${ALBUMS_ROOT}/summer --except ${photos[2]}`);
      assertEquals(result.moved, 2);
      assertEquals(await readMembers(vfs, `${GROUPS}/2019-06-18`), [photos[2]]);
      const meta = await metaOf('2019-06-18');
      assertEquals([meta.pinned, meta.memberKey, meta.memberCount], [true, memberKeyOf(await idsOf([photos[2]])), 1]);
    });

    await t.step('a group whose members changed is refused, and nothing is written for it', async () => {
      const photos = await stagePhotos(vfs, BATCH, 'reed', 2, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-19`, 'Reeds', photos, owner);
      const before = (await journal()).entries.length;
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-19 --into ${ALBUMS_ROOT}/summer --expect 0000000000000000`);
      assertEquals([result.changed, result.moved, result.journal], [[`${GROUPS}/2019-06-19`], 0, null]);
      assertEquals(await readMembers(vfs, `${GROUPS}/2019-06-19`), photos);
      assertEquals((await journal()).entries.length, before);
    });

    await t.step('a dry run says where the files would go and writes nothing', async () => {
      const result = await client.execJson<StagingPromoteResult>(`staging promote 2019-06-19 --name Reeds --dry-run`);
      assertEquals([result.dryRun, result.moved, result.album?.path, result.journal], [true, 2, `${ALBUMS_ROOT}/Reeds`, null]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/Reeds`), false);
    });

    await t.step('discard puts the members in one trash batch and takes them out of every group', async () => {
      const photos = await stagePhotos(vfs, BATCH, 'blur', 3, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-20`, 'Blurry', photos.slice(0, 2), owner);
      // The second is in Reeds as well, which keeps a key that matches what is left in it.
      await makeGroup(vfs, `${GROUPS}/2019-06-19`, 'Reeds', [...await readMembers(vfs, `${GROUPS}/2019-06-19`), photos[1]], owner);
      const result = await client.execJson<StagingDiscardResult>(`staging discard 2019-06-20`);
      assertEquals([result.files, result.batches.length, result.groupsRemoved], [2, 1, [`${GROUPS}/2019-06-20`]]);
      assertEquals(result.groupsChanged, [`${GROUPS}/2019-06-19`]);
      const reeds = await readMembers(vfs, `${GROUPS}/2019-06-19`);
      assertEquals((await metaOf('2019-06-19')).memberKey, memberKeyOf(await idsOf(reeds)));
      const trash = await client.execJson<{ id: string; type: string; count?: number; label?: string }[]>('trash list');
      assertEquals(trash.map((row) => [row.id, row.type, row.count, row.label]), [[result.batches[0], 'batch', 2, 'Discarded from Inbox: “Blurry”']]);
      assertEquals([await vfs.exists(ADMIN_ACCESS, photos[0]), await vfs.exists(ADMIN_ACCESS, photos[2])], [false, true]);
      const [entry] = (await journal()).entries;
      assertEquals([entry.action, entry.files, entry.batches, entry.summary], ['discard', 2, result.batches, '2 files discarded']);
    });

    await t.step('discard takes a folder, and every group link into it', async () => {
      const folder = `${STAGING}/files/inbox/old-phone`;
      await cmd.shouldSucceed(`mkdir -p ${folder}`);
      const photos = await stagePhotos(vfs, folder, 'shot', 2, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-21`, 'Old phone', photos, owner);
      const result = await client.execJson<StagingDiscardResult>(`staging discard ${folder}`);
      assertEquals([result.files, result.groupsRemoved], [2, [`${GROUPS}/2019-06-21`]]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, folder), false);
    });

    await t.step('later puts a group aside, and a rewrite by the organizer keeps it there', async () => {
      const on = await client.execJson<StagingLaterResult>('staging later 2019-06-19');
      assertEquals(on.later, true);
      const at = (await vfs.get<{ stagingLaterAt?: string }>(ADMIN_ACCESS, `${GROUPS}/2019-06-19`)).attrs.stagingLaterAt;
      assert(at);
      // The organizer rewrites a group's name and `autoAlbum`, and nothing else.
      const members = await readMembers(vfs, `${GROUPS}/2019-06-19`);
      await vfs.update(ADMIN_ACCESS, `${GROUPS}/2019-06-19`, {
        attrs: {
          name: 'Reeds',
          autoAlbum: { memberKey: memberKeyOf(members.map((_, i) => String(i))), memberCount: members.length, generatedAt: '', generatedBy: 'test' } satisfies AutoAlbumMeta,
        },
      });
      const list = await client.execJson<{ items: { name: string; staging?: { later?: string } }[] }>(`album list ${GROUPS}`);
      assertEquals(list.items.find((item) => item.name === '2019-06-19')?.staging?.later, at);
      await client.execJson<StagingLaterResult>('staging later 2019-06-19 --off');
      assertEquals((await vfs.get<{ stagingLaterAt?: string }>(ADMIN_ACCESS, `${GROUPS}/2019-06-19`)).attrs.stagingLaterAt, undefined);
    });

    await t.step('accept files into the category destination; a dry run plans the same and writes nothing', async () => {
      const photos = await stagePhotos(vfs, BATCH, 'meadow', 2, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-22`, 'Meadow', photos, owner);
      // Without a destination an event is a new album, unsure: below the default floor.
      const unsure = await client.execJson<StagingAcceptResult>('staging accept 2019-06-22 --dry-run');
      assertEquals(unsure.skipped, [{ group: `${GROUPS}/2019-06-22`, reason: 'below-confidence' }]);
      // The web interface's "Every proposal" asks for the least sure as well.
      const any = await client.execJson<StagingAcceptResult>('staging accept 2019-06-22 --confidence low --dry-run');
      assertEquals([any.skipped, any.plan.map((row) => row.proposal.action)], [[], ['new']]);

      await cmd.shouldSucceed(`staging category inbox --destination ${ALBUMS_ROOT}/summer`);
      const before = (await journal()).entries.length;
      const plan = await client.execJson<StagingAcceptResult>('staging accept 2019-06-22 --dry-run');
      assertEquals(plan.plan.map((row) => [row.group, row.proposal.action, row.files]), [[`${GROUPS}/2019-06-22`, 'existing', 2]]);
      assertEquals([plan.journal, plan.skipped, (await journal()).entries.length], [[], [], before]);
      const high = await client.execJson<StagingAcceptResult>('staging accept 2019-06-22 --confidence high');
      assertEquals([high.journal, high.skipped], [[], [{ group: `${GROUPS}/2019-06-22`, reason: 'below-confidence' }]]);

      const done = await client.execJson<StagingAcceptResult>('staging accept 2019-06-22');
      assertEquals(done.plan, plan.plan);
      assertEquals(done.journal.length, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer/meadow-0.jpg`), true);
      await cmd.shouldSucceed('staging category inbox --no-destination');
    });

    await t.step('a move to another category takes the files out of their groups first', async () => {
      await cmd.shouldSucceed('staging category scans --create --kind scans');
      const folder = `${STAGING}/files/inbox/box-3`;
      await cmd.shouldSucceed(`mkdir -p ${folder}`);
      const photos = await stagePhotos(vfs, folder, 'print', 2, owner);
      const kept = await stagePhotos(vfs, BATCH, 'print-kept', 1, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-23`, 'Prints', [...photos, ...kept], owner);
      const result = await client.execJson<StagingMoveResult>(`staging move ${folder} ${STAGING}/files/scans`);
      assertEquals([result.moved, result.left, result.failed], [1, 1, []]);
      assertEquals(await readMembers(vfs, `${GROUPS}/2019-06-23`), kept);
      assertEquals((await metaOf('2019-06-23')).memberKey, memberKeyOf(await idsOf(kept)));
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${STAGING}/files/scans/box-3/print-0.jpg`), true);
      const check = await client.execJson<{ ok: boolean; problems: unknown[] }>('staging check');
      assertEquals(check.problems, []);
    });

    await t.step('status counts what was decided per category', async () => {
      const status = await client.execJson<{ categories: { name: string; decided: { filed: number; discarded: number } }[] }>('staging status');
      assertEquals(status.categories.find((category) => category.name === 'inbox')?.decided, { filed: 3 + 2 + 4 + 2 + 2, discarded: 2 + 2 });
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
