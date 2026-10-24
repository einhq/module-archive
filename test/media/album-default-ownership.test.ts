/**
 * What a new album is owned by, and what the sharing dialog's "Default" means.
 *
 * Three settings decide it. The creator's own uid/gid and a literal `0o755`
 * would make every album world-readable and put it in the creator's private
 * group, so the household could not see it and the internet could.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'], rootMount: true, boot: true });

type ShareInfo = {
  mode: number;
  owner: { uid: number };
  group: { gid: number; groupname?: string };
  default: { mode: number; uid: number; gid: number; ownerName?: string; groupName?: string; active: boolean };
};

Deno.test({
  name: 'album default ownership',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);

    const usersGid = (await vfs.get<{ gid: number }>(ADMIN_ACCESS, '/etc/groups/users')).attrs.gid;

    await t.step('with nothing configured, an album takes the declared defaults', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/plain`);

      const node = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/plain`);
      assertEquals(node.props.mode & 0o777, 0o750);
      assertEquals(node.props.gid, usersGid);
    });

    await t.step('an album follows the configured mode and group', async () => {
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_MODE 0770');
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_GROUP users');

      // Deliberately the same shell that wrote the settings. A shell's
      // environment is a snapshot taken at open, so this only works because the
      // creation path reads the settings files rather than its own environment —
      // which is what lets the web UI, whose shell lives as long as the tab,
      // apply a change without a reload.
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/trip`);

      const node = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/trip`);
      assertEquals(node.props.mode, 0o770);
      assertEquals(node.props.gid, usersGid);
    });

    await t.step('share-info reports the default and marks the album as on it', async () => {
      const info = await client.execJson<ShareInfo>(`share-info ${ALBUMS_ROOT}/trip`);
      assertEquals(info.default.mode, 0o770);
      assertEquals(info.default.gid, usersGid);
      assertEquals(info.default.groupName, 'users');
      assertEquals(info.default.active, true);
    });

    await t.step('a widened album is no longer on the default, and can be put back', async () => {
      await cmd.shouldSucceed(`share-set ${ALBUMS_ROOT}/trip --mode 0755`);

      const widened = await client.execJson<ShareInfo>(`share-info ${ALBUMS_ROOT}/trip`);
      assertEquals(widened.default.active, false);

      // Mode and the configured owner and group in one pass, which is what the dialog's "Use
      // default" sends.
      await cmd.shouldSucceed(`share-set ${ALBUMS_ROOT}/trip --mode 0770 -b --default-owner`);

      const restored = await client.execJson<ShareInfo>(`share-info ${ALBUMS_ROOT}/trip`);
      assertEquals(restored.default.active, true);
      assertEquals(restored.mode & 0o777, 0o770);
    });

    await t.step('a personal preference narrows the system default', async () => {
      await cmd.shouldSucceed('config set CFG_USER_DEFAULT_SHARE private');

      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/secret`);

      const node = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/secret`);
      assertEquals(node.props.mode & 0o077, 0, 'private must leave nothing for group or everyone');
      assert(node.props.mode & 0o700, 'the person who made it keeps full access');
    });

    await t.step('an unresolvable group falls back to the creator rather than failing', async () => {
      await cmd.shouldSucceed('config unset CFG_USER_DEFAULT_SHARE');
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_GROUP nosuchgroup');

      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/fallback`);

      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/fallback`));
    });

    await t.step('the server gives a new album an owner and group its creator could not', async () => {
      await cmd.shouldSucceed('group-create family --gid 7300');
      await cmd.shouldSucceed('user-create anna --uid 3100');
      await cmd.shouldSucceed('user-passwd anna --new-password secret');
      await cmd.shouldSucceed(`chmod 0777 ${ALBUMS_ROOT}`);
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_OWNER admin');
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_GROUP family');
      await cmd.shouldSucceed('mkdir -p /srv/closed && chmod 0755 /srv/closed');

      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret' });
      const asAnna = testCommands(anna);
      try {
        await asAnna.shouldSucceed(`album create ${ALBUMS_ROOT}/picnic`);
        const album = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/picnic`);
        assertEquals([album.props.uid, album.props.gid], [0, 7300]);

        // Neither as she likes: not to another user, not into a group she is not in.
        await asAnna.shouldSucceed(`mkdir ${ALBUMS_ROOT}/own`);
        assertEquals((await anna.exec(`chown admin ${ALBUMS_ROOT}/own`)).success, false);
        assertEquals((await anna.exec(`chown :family ${ALBUMS_ROOT}/own`)).success, false);
        assertEquals((await anna.exec(`share-set ${ALBUMS_ROOT}/own --owner admin`)).success, false);
        const own = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/own`);
        assertEquals(own.props.uid, 3100);

        // And the default only on what she may write.
        assertEquals((await anna.exec('share-set /srv/closed --default-owner')).success, false);
      } finally {
        anna.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
