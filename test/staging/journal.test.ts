/**
 * The journal: every decision that takes staged files out of an inbox is one entry — from
 * `staging promote`, `staging accept`, `staging discard` and `album add` — listed newest first,
 * per category, a page at a time; its totals count what was decided and not undone.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumAddResult } from '@archive/media/api';
import type { StagingAcceptResult, StagingDiscardResult, StagingJournalEntry, StagingJournalPage, StagingPromoteResult } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { makeGroup, stagePhotos } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/admin/staging';
const BATCH = `${STAGING}/files/inbox/upload-2019-06-14`;
const SCANS = `${STAGING}/files/scans/box-3`;
const GROUPS = `${STAGING}/albums/inbox`;

Deno.test({ name: 'staging journal', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed('staging category scans --create --kind scans');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} ${BATCH} ${SCANS}`);
    await cmd.shouldSucceed(`mknode -t album ${ALBUMS_ROOT}/summer --as name='Summer 2019'`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const owner = { uid: home.props.uid, gid: home.props.gid };
    const photos = await stagePhotos(vfs, BATCH, 'lake', 6, owner);
    const prints = await stagePhotos(vfs, SCANS, 'print', 2, owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-14`, 'Lake weekend', photos.slice(0, 2), owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-15`, 'Pier', photos.slice(2, 4), owner);
    await makeGroup(vfs, `${GROUPS}/2019-06-16`, 'Shore', photos.slice(4, 5), owner);

    const ids: string[] = [];
    await t.step('each decision makes one entry', async () => {
      ids.push((await client.execJson<StagingPromoteResult>(`staging promote 2019-06-14 --name 'Lake weekend'`)).journal!);
      await cmd.shouldSucceed(`staging category inbox --destination ${ALBUMS_ROOT}/summer`);
      ids.push(...(await client.execJson<StagingAcceptResult>('staging accept 2019-06-15')).journal);
      ids.push((await client.execJson<StagingDiscardResult>('staging discard 2019-06-16')).journal!);
      ids.push(...(await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/summer ${photos[5]}`)).journal!);
      ids.push(...(await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/summer ${prints.join(' ')}`)).journal!);
      assertEquals(ids.length, 5);
      assertEquals(new Set(ids).size, 5);
    });

    const entriesOf = async (command: string): Promise<StagingJournalEntry[]> => (await client.execJson<StagingJournalPage>(command)).entries;

    await t.step('newest first, per category, and every category without one', async () => {
      const inbox = await entriesOf('staging journal inbox');
      assertEquals(inbox.map((entry) => entry.id), ids.slice(0, 4).reverse());
      assertEquals(inbox.map((entry) => [entry.action, entry.files, entry.state]), [['file', 1, 'done'], ['discard', 1, 'done'], ['promote', 2, 'done'], [
        'promote',
        2,
        'done',
      ]]);
      assertEquals(inbox[0].destination, { path: `${ALBUMS_ROOT}/summer`, title: 'Summer 2019' });
      assertEquals((await entriesOf('staging journal scans')).map((entry) => [entry.id, entry.category, entry.files]), [[ids[4], 'scans', 2]]);
      assertEquals((await entriesOf('staging journal')).map((entry) => entry.id), [...ids].reverse());
      assertEquals((await entriesOf('staging journal inbox --action discard')).map((entry) => entry.id), [ids[2]]);
    });

    await t.step('pages follow one another by their cursor, to the last', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: StagingJournalPage = await client.execJson<StagingJournalPage>(`staging journal --limit 2${cursor ? ` --cursor ${cursor}` : ''}`);
        seen.push(...page.entries.map((entry) => entry.id));
        cursor = page.cursor;
      } while (cursor);
      assertEquals(seen, [...ids].reverse());
    });

    await t.step('totals count files decided and not undone', async () => {
      assertEquals((await client.execJson<StagingJournalPage>('staging journal inbox')).totals, { filed: 5, discarded: 1 });
      assertEquals((await client.execJson<StagingJournalPage>('staging journal')).totals, { filed: 7, discarded: 1 });
      await cmd.shouldSucceed(`staging undo ${ids[0]}`);
      assertEquals((await client.execJson<StagingJournalPage>('staging journal inbox')).totals, { filed: 3, discarded: 1 });
    });

    await t.step('an entry is a private db-tier file in the journal', async () => {
      const entry = await vfs.get(ADMIN_ACCESS, `${STAGING}/journal/${ids[1]}`);
      assertEquals([entry.type, entry.props.tier, entry.props.mode & 0o777, entry.props.uid], ['file', 'db', 0o600, owner.uid]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
