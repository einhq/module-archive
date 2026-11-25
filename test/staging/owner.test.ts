/**
 * The decisions as the inbox's owner makes them, not an administrator: Anna Andersson promotes,
 * discards and files her own organizer-made groups, lists her journal and undoes each
 * decision. A promote that fails part-way leaves a `partial` entry that undoes what it did. A group
 * promoted to the library's default owner comes back to her; a journal entry she writes herself is
 * undone with no more than her own authority.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumAddResult } from '@archive/media/api';
import type { StagingDiscardResult, StagingJournalPage, StagingPromoteResult, StagingUndoResult } from '@archive/staging/api';
import { type AutoAlbumMeta, memberKeyOf } from '@archive/staging/auto-album';
import { assertEquals, assertStringIncludes } from '@std/assert';
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

    await t.step('a group promoted to the default owner comes back to her as it was', async () => {
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_OWNER admin');
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_GROUP users');
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_MODE 0770');
      const beach = await stagePhotos(vfs, BATCH, 'beach', 2, owner);
      await makeGroup(vfs, `${GROUPS}/2019-06-20`, 'Beach', beach, owner);
      const result = await anna.execJson<StagingPromoteResult>(`staging promote 2019-06-20 --name Beach`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/Beach`)).props.uid, 0);
      assertEquals((await undo(result.journal!)).failed, []);
      const group = await vfs.get(ADMIN_ACCESS, `${GROUPS}/2019-06-20`);
      assertEquals([group.props.uid, group.props.gid, group.props.mode & 0o777], [3400, home.props.gid, 0o700]);
    });

    await t.step('a journal entry she writes herself is undone with no more than her own authority', async () => {
      const at = new Date().toISOString();
      /** Write entry `id`, a filing whose group was `target`, and undo it: what refused it, if anything did. */
      const forge = async (id: string, target: string, from: string, props: Record<string, unknown>): Promise<string | undefined> => {
        const node = await vfs.get(ADMIN_ACCESS, target);
        const plan = { kind: 'filed', moves: [], groups: [], group: { id: node.id, from, to: target, links: [], props, attrs: { routingKey: 'system.vfs.#' } } };
        const entry = { inbox: 'anna', category: 'inbox', action: 'promote', files: 0, summary: 'forged', groups: [], at, state: 'done' };
        await asAnna.shouldSucceed(`echo '${JSON.stringify(plan)}' > ${STAGING}/journal/${id}`);
        await asAnna.shouldSucceed(`attrs -J 'stagingJournal=${JSON.stringify(entry)}' ${STAGING}/journal/${id}`);
        return (await anna.exec(`staging undo ${id}`)).error;
      };
      /** Node `id`, wherever the undo left it. */
      const node = async (id: string) => vfs.get<{ routingKey?: string }>(ADMIN_ACCESS, (await vfs.resolveIdPaths(ADMIN_ACCESS, [id])).get(id)![0]);

      // Her own node, which the plan would give to the administrator with an administrator's attr.
      await asAnna.shouldSucceed('mkdir /home/anna/album1');
      const own = await vfs.get(ADMIN_ACCESS, '/home/anna/album1');
      const forged = await forge('01HZXY7Z9ABCDEFG8JKMNPQRS0', '/home/anna/album1', '/home/anna/pwned', { uid: 0, gid: 0, mode: 0o755 });
      assertStringIncludes(forged ?? '', 'Access denied');
      assertEquals([(await node(own.id)).props.uid, (await node(own.id)).attrs.routingKey], [3400, undefined]);

      // An album the default owner holds comes to her, and without the attr.
      await asAnna.shouldSucceed(`album create ${ALBUMS_ROOT}/Picnic`);
      const picnic = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/Picnic`);
      assertEquals(picnic.props.uid, 0);
      const picked = await forge('01HZXY7Z9ABCDEFG8JKMNPQRS1', `${ALBUMS_ROOT}/Picnic`, `${GROUPS}/picnic`, { uid: 3400, gid: home.props.gid, mode: 0o700 });
      assertStringIncludes(picked ?? '', 'change routingKey');
      assertEquals([(await node(picnic.id)).props.uid, (await node(picnic.id)).attrs.routingKey], [3400, undefined]);

      // Another member's album she may write is not hers to take.
      await cmd.shouldSucceed('user-create bo --uid 3500');
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/Bo && chown bo ${ALBUMS_ROOT}/Bo && chmod 0777 ${ALBUMS_ROOT}/Bo`);
      const bo = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/Bo`);
      const taken = await forge('01HZXY7Z9ABCDEFG8JKMNPQRS2', `${ALBUMS_ROOT}/Bo`, `${GROUPS}/bo`, { uid: 3400, gid: home.props.gid, mode: 0o700 });
      assertStringIncludes(taken ?? '', `${ALBUMS_ROOT}/Bo is not the library's default owner's, to take back`);
      assertEquals([(await node(bo.id)).props.uid, await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/Bo`)], [3500, true]);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
