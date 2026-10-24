import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumAddResult } from '@archive/media/api';
import { type AutoAlbumMeta, memberKeyOf } from '@archive/staging/auto-album';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { readMembers } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'album add files a staged file in a library album',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  // A batch folder within a category: a staged file at any depth leaves staging when it is filed.
  const files = '/home/anna/staging/files/inbox/upload-2026-10-16/phone';
  const suggested = '/home/anna/staging/albums/inbox';
  const album = `${ALBUMS_ROOT}/holiday`;
  const clients: ShellClient[] = [admin];
  try {
    await cmd.shouldSucceed('group-create family --gid 7200');
    for (const user of ['anna', 'bob']) {
      await cmd.shouldSucceed(`user-create ${user}`);
      await cmd.shouldSucceed(`user-passwd ${user} --new-password secret1`);
      await cmd.shouldSucceed(`group-add-member family ${user}`);
    }
    await cmd.shouldSucceed('staging init --user anna');
    // A family album that keeps its members in files/, as a promoted one does.
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed(`mknode -t album ${album}`);
    await cmd.shouldSucceed(`mkdir ${album}/files && echo held > ${album}/files/held.jpg`);
    await cmd.shouldSucceed(`share-set ${album} --group family --mode 0770`);

    const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
    const bob = await testCtx.server.createShellClient({ username: 'bob', password: 'secret1' });
    clients.push(anna, bob);
    const asAnna = testCommands(anna);
    await asAnna.shouldSucceed(`mkdir -p ${files}`);
    await asAnna.shouldSucceed(`echo photo > ${files}/beach.jpg && echo other > ${files}/dune.jpg && echo third > ${files}/rock.jpg`);
    await asAnna.shouldSucceed(`ln -s ${files}/beach.jpg /home/anna/favourite.jpg`);
    // Two suggestions holding it: one beside another staged file, one of it alone.
    const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
    /** A suggestion of `members`, keyed by their ids unless `memberKey` says otherwise (null: no key). */
    const suggest = async (name: string, members: string[], memberKey?: string | null) => {
      await asAnna.shouldSucceed(`mknode -t album ${suggested}/${name} --as origin=auto`);
      for (const member of members) await asAnna.shouldSucceed(`ln -s ${member} ${suggested}/${name}/${member.split('/').pop()}`);
      const key = memberKey === null ? {} : { memberKey: memberKey ?? memberKeyOf(await Promise.all(members.map(idOf))) };
      await vfs.update(ADMIN_ACCESS, `${suggested}/${name}`, { attrs: { name, autoAlbum: { ...key, memberCount: members.length, generatedName: name } } });
    };
    const metaOf = async (name: string) => (await vfs.get<{ autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${suggested}/${name}`)).attrs.autoAlbum;
    await suggest('day', [`${files}/beach.jpg`, `${files}/dune.jpg`]);
    await suggest('moment', [`${files}/beach.jpg`]);
    await suggest('unkeyed', [`${files}/beach.jpg`, `${files}/dune.jpg`], null);

    await t.step("a staged file moves into the album's files/, and links to it follow", async () => {
      const result = await anna.execJson<AlbumAddResult>(`album add ${album} ${files}/beach.jpg`);
      assertEquals(result.moved, [{ path: `${files}/beach.jpg`, to: `${album}/files/beach.jpg` }]);
      assertEquals(result.added, []);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${files}/beach.jpg`), false);
      assertEquals((await anna.execJson<{ softlink: string }>('props -L /home/anna/favourite.jpg')).softlink, `${album}/files/beach.jpg`);
    });

    await t.step('it is shared as the album is, and stays its uploader’s', async () => {
      await testCommands(bob).shouldSucceed(`cat ${album}/files/beach.jpg`);
      const props = (await vfs.get(ADMIN_ACCESS, `${album}/files/beach.jpg`)).props;
      assertEquals(props.gid, 7200);
      assertEquals(props.mode & 0o777, 0o770);
      assertEquals(props.uid, (await vfs.get(ADMIN_ACCESS, '/home/anna')).props.uid);
    });

    await t.step('it leaves the suggestions, which still read as generated', async () => {
      assertEquals(await readMembers(vfs, `${suggested}/day`), [`${files}/dune.jpg`]);
      const meta = await metaOf('day');
      assertEquals(meta.memberKey, memberKeyOf([await idOf(`${files}/dune.jpg`)]));
      assertEquals(meta.memberCount, 1);
      assertEquals(meta.pinned, undefined);
      // The suggestion it was all of is gone.
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${suggested}/moment`, { follow: false }), false);
    });

    await t.step('an album without a key keeps none', async () => {
      const unkeyed = await metaOf('unkeyed');
      assertEquals([unkeyed.memberKey, unkeyed.memberCount], [undefined, 1]);
    });

    await t.step('adding to an album the caller cannot write into leaves the files as they were', async () => {
      const readonly = `${ALBUMS_ROOT}/readonly`;
      await cmd.shouldSucceed(`mknode -t album ${readonly} && mkdir ${readonly}/files`);
      await cmd.shouldSucceed(`chmod -r 0755 ${readonly}`);
      const before = { mode: (await vfs.get(ADMIN_ACCESS, `${files}/dune.jpg`)).props.mode, day: await metaOf('day') };

      await asAnna.shouldFailWith(`album add ${readonly} ${files}/dune.jpg`, `cannot write into ${readonly}/files`);

      assertEquals((await vfs.get(ADMIN_ACCESS, `${files}/dune.jpg`)).props.mode, before.mode);
      assertEquals(await readMembers(vfs, `${suggested}/day`), [`${files}/dune.jpg`]);
      assertEquals(await metaOf('day'), before.day);
    });

    await t.step('a staged file added to a suggestion in its own staging is linked', async () => {
      const result = await anna.execJson<AlbumAddResult>(`album add ${suggested}/day ${files}/rock.jpg`);
      assertEquals(result.moved, []);
      assertEquals(result.added.map((entry) => entry.path), [`${files}/rock.jpg`]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${files}/rock.jpg`), true);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
