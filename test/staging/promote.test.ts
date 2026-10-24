import { ALBUMS_ROOT } from '@archive/paths';
import type { StagingPromoteResult } from '@archive/staging/api';
import type { AutoAlbumMeta } from '@archive/staging/auto-album';
import { assertEquals } from '@std/assert';
import type { RelationAttrs } from '@ein/api';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'staging promote',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const files = '/home/admin/staging/files/inbox';
  const suggested = '/home/admin/staging/albums/inbox';
  const album = `${ALBUMS_ROOT}/trip`;
  try {
    // The default sharing group, which a booted system has and this context does not.
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed(`mknode -t album ${suggested}/trip --as origin=auto --as name=Trip`);
    await cmd.shouldSucceed(`mknode -t album ${suggested}/other --as origin=auto --as name=Other`);
    for (const name of ['photo.jpg', 'boat.jpg', 'dune.jpg']) {
      await cmd.shouldSucceed(`mknode -t file ${files}/${name} --as mimetype=image/jpeg`);
    }
    await cmd.shouldSucceed(`mkdir -p ${files}/photo.jpg/metadata ${files}/photo.jpg/thumbnails`);
    await cmd.shouldSucceed(`mknode -t file ${files}/photo.jpg/metadata/exif`);
    await cmd.shouldSucceed(`mknode -t file ${files}/photo.jpg/thumbnails/grid`);
    await cmd.shouldSucceed(`ln -s ${files}/photo.jpg ${suggested}/trip/photo.jpg`);
    await cmd.shouldSucceed(`ln -s ${files}/boat.jpg ${suggested}/trip/boat.jpg`);
    await cmd.shouldSucceed(`ln -s ${files}/photo.jpg ${suggested}/trip/coverPhoto`);
    await cmd.shouldSucceed(`ln -s ${files}/photo.jpg ${suggested}/other/photo.jpg`);
    await cmd.shouldSucceed(`ln -s ${files}/dune.jpg ${suggested}/other/dune.jpg`);
    await vfs.update(ADMIN_ACCESS, `${suggested}/other`, { attrs: { autoAlbum: { memberCount: 2, generatedName: 'Other' } } });
    // Two members related to each other, and one to a person outside staging.
    await cmd.shouldSucceed('mkdir -p /archive/people && mknode -t person /archive/people/anna');
    await cmd.shouldSucceed(`relate ${files}/photo.jpg ${files}/boat.jpg near`);
    await cmd.shouldSucceed(`relate /archive/people/anna ${files}/photo.jpg depicted-in --reverse depicts`);
    await cmd.shouldSucceed(`mkdir -p ${suggested}/trip/files`);
    await cmd.shouldSucceed(`mknode -t file ${suggested}/trip/files/photo.jpg`);

    await t.step('moves nodes, preserves descendants, repairs links and opens access', async () => {
      const result = await client.execJson<StagingPromoteResult>('staging promote trip --name trip');
      assertEquals(result.album, { path: album, title: 'trip', created: true });
      assertEquals(result.moved, 2);
      // A name taken in files/ gives way to the first free one, extension kept.
      const photo = `${album}/files/photo (2).jpg`;
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${photo}/metadata/exif`), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${photo}/thumbnails/grid`), true);
      const attrs = await client.execJson<{ origin?: string; autoAlbum?: unknown }>(`attrs ${album}`);
      assertEquals(attrs.origin, undefined);
      assertEquals(attrs.autoAlbum, undefined);
      // The album holds its files in files/, and has its matching profile; the member links are gone.
      assertEquals((await vfs.children(ADMIN_ACCESS, album)).map((entry) => entry.name).sort(), ['.profile', 'coverPhoto', 'files']);
      const cover = await vfs.get(ADMIN_ACCESS, `${album}/coverPhoto`, { readlink: true });
      assertEquals(cover.props.softlink, photo);
      // Someone signed in, who carries the users group as every session does.
      assertEquals(await vfs.exists({ uid: 2000, gid: 2000, gids: [2000, 1002] }, photo), true);
    });

    await t.step('a promoted file leaves the other suggestions', async () => {
      const other = await vfs.children(ADMIN_ACCESS, `${suggested}/other`);
      assertEquals(other.map((entry) => entry.node.props.softlink), [`${files}/dune.jpg`]);
      assertEquals((await vfs.get<{ autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${suggested}/other`)).attrs.autoAlbum.memberCount, 1);
    });

    await t.step('relation links between moved files, and from outside, keep both their target and their peer', async () => {
      const photo = `${album}/files/photo (2).jpg`;
      const boat = `${album}/files/boat.jpg`;
      const near = await vfs.get<RelationAttrs>(ADMIN_ACCESS, `${photo}/relations/near-boat.jpg`, { readlink: true });
      assertEquals(near.props.softlink, boat);
      assertEquals(near.attrs.relation?.peerLink, `${boat}/relations/near-photo.jpg`);
      const back = await vfs.get<RelationAttrs>(ADMIN_ACCESS, `${boat}/relations/near-photo.jpg`, { readlink: true });
      assertEquals(back.props.softlink, photo);
      assertEquals(back.attrs.relation?.peerLink, `${photo}/relations/near-boat.jpg`);

      const depicted = await vfs.get<RelationAttrs>(ADMIN_ACCESS, '/archive/people/anna/relations/depicted-in-photo.jpg', { readlink: true });
      assertEquals(depicted.props.softlink, photo);
      assertEquals(depicted.attrs.relation?.peerLink, `${photo}/relations/depicts-anna`);
      // The half inside the moved file points out of it, and is left as it was.
      const depicts = await vfs.get<RelationAttrs>(ADMIN_ACCESS, `${photo}/relations/depicts-anna`, { readlink: true });
      assertEquals(depicts.props.softlink, '/archive/people/anna');
      assertEquals(depicts.attrs.relation?.peerLink, '/archive/people/anna/relations/depicted-in-photo.jpg');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
