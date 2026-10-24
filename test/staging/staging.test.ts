import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import type { AlbumMatchReport, StagingStatus } from '@archive/staging/api';
import { makeGroup, stagePhotos } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'staging for a non-admin user, and delete',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('staging init --user admin');

    await t.step('non-admin users can run the staging and suggestion commands', async () => {
      await cmd.shouldSucceed('user-create viewer --uid 3000');
      await cmd.shouldSucceed('user-passwd viewer --new-password secret');
      const viewer = await testCtx.server.createShellClient({ username: 'viewer', password: 'secret' });
      try {
        await testCommands(viewer).shouldSucceed('staging init');
        const status = await viewer.execJson<StagingStatus>('staging status');
        assertEquals([status.user, status.initialized], ['viewer', true]);
        assertEquals(status.categories[0].counts.files, 0);
        await assertRejects(() => vfs.get({ uid: 2000, gid: 2000, gids: [2000] }, '/home/viewer/staging/files'));
        const report = await viewer.execJson<AlbumMatchReport>(`auto-album-assign /home/viewer/staging/files/inbox --root ${ALBUMS_ROOT}`);
        assertEquals(report.subjects.map((subject) => [subject.items, subject.candidates]), [[0, []]]);
      } finally {
        viewer.close();
      }
    });

    await t.step('delete takes the suggestion away, and never a photo', async () => {
      const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
      const owner = { uid: home.props.uid, gid: home.props.gid };
      const [keep] = await stagePhotos(vfs, '/home/admin/staging/files/inbox', 'keep', 1, owner);
      await makeGroup(vfs, '/home/admin/staging/albums/inbox/discard', 'Discard', [keep], owner);
      await cmd.shouldSucceed('staging delete discard');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/staging/albums/inbox/discard', { follow: false }), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, keep), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
