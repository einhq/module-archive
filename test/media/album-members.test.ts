/**
 * An album's members, by its own rules (`@archive/media/album-members`), as `search --under` and
 * `members` see them through the `members-album` command and as the command answers itself: the imported
 * `files/` layout, links followed, the cover left out, stacks of similar photos folded.
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import type { ContainerListing } from '@ein/client';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Hit = { path: string; memberPath?: string; name: string; stackCount?: number };
type Results = { results: Hit[]; truncated: boolean; cursor: string | null };
type LayoutResults = { layout: { items: unknown[][] } };

const names = (r: Results) => r.results.map((e) => e.path.split('/').pop());

Deno.test({ name: 'album members', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, {
      props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: target },
    });

  const mkmedia = async (path: string, attrs: Record<string, unknown>) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...attrs } });
  };

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} ${PEOPLE_ROOT}`);
    // An imported album: everything under files/, nothing in the album itself.
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'imported', { attrs: { name: 'Imported' } });
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/imported/files`);
    await mkmedia(`${ALBUMS_ROOT}/imported/files/b1998.jpg`, { ...captureTime('1998-03-12T08:30:00') });
    await mkmedia(`${ALBUMS_ROOT}/imported/files/d2010.jpg`, { ...captureTime('2010-05-05T12:00:00') });

    await t.step('an imported album is its files/ child', async () => {
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/imported`)), ['d2010.jpg', 'b1998.jpg']);
    });

    await t.step('links are members, the cover is not', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'auto', { attrs: { name: 'Auto' } });
      await mklink(`${ALBUMS_ROOT}/auto`, 'm1', `${ALBUMS_ROOT}/imported/files/d2010.jpg`);
      await mklink(`${ALBUMS_ROOT}/auto`, 'coverPhoto', `${ALBUMS_ROOT}/imported/files/b1998.jpg`);

      const res = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/auto`);
      assertEquals(res.results.map((r) => [r.path, r.memberPath]), [[`${ALBUMS_ROOT}/imported/files/d2010.jpg`, `${ALBUMS_ROOT}/auto/m1`]]);
    });

    await t.step('a search after a write sees it: a member added, re-dated where it lives, removed, the album moved', async () => {
      const under = async (path: string) => (await client.execJson<Results>(`search --under ${path} --sort time`)).results.map((r) => r.memberPath ?? r.path);
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'kept', { attrs: { name: 'Kept' } });
      await mklink(`${ALBUMS_ROOT}/kept`, 'old', `${ALBUMS_ROOT}/imported/files/b1998.jpg`);
      assertEquals(await under(`${ALBUMS_ROOT}/kept`), [`${ALBUMS_ROOT}/kept/old`]);

      await mklink(`${ALBUMS_ROOT}/kept`, 'new', `${ALBUMS_ROOT}/imported/files/d2010.jpg`);
      assertEquals(await under(`${ALBUMS_ROOT}/kept`), [`${ALBUMS_ROOT}/kept/old`, `${ALBUMS_ROOT}/kept/new`]);

      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/imported/files/d2010.jpg`, { attrs: captureTime('1990-01-01T00:00:00') });
      assertEquals(await under(`${ALBUMS_ROOT}/kept`), [`${ALBUMS_ROOT}/kept/new`, `${ALBUMS_ROOT}/kept/old`]);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/imported/files/d2010.jpg`, { attrs: captureTime('2010-05-05T12:00:00') });

      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/kept/old`);
      assertEquals(await under(`${ALBUMS_ROOT}/kept`), [`${ALBUMS_ROOT}/kept/new`]);

      await cmd.shouldSucceed(`mv ${ALBUMS_ROOT}/kept ${ALBUMS_ROOT}/moved`);
      assertEquals((await client.exec(`search --under ${ALBUMS_ROOT}/kept`)).success, false);
      assertEquals(await under(`${ALBUMS_ROOT}/moved`), [`${ALBUMS_ROOT}/moved/new`]);
    });

    await t.step('members-album answers with every member and says who stands for whom', async () => {
      const listing = await client.execJson<ContainerListing>(`members-album ${ALBUMS_ROOT}/auto`);
      assertEquals(listing.truncated, false);
      assertEquals(listing.members.map((member) => [member.path, member.memberPath]), [[`${ALBUMS_ROOT}/imported/files/d2010.jpg`, `${ALBUMS_ROOT}/auto/m1`]]);
      assert(listing.members[0].id);
      assertEquals((await client.exec(`members-album ${ALBUMS_ROOT}/imported/files`)).success, false, 'a directory is not an album');
    });

    await t.step("members runs an album's members-album, and lists anything else as a directory", async () => {
      // The album's own rule: the link is a member, the cover link is not.
      assertEquals(await client.execJson<ContainerListing>(`members ${ALBUMS_ROOT}/auto`), await client.execJson<ContainerListing>(`members-album ${ALBUMS_ROOT}/auto`));
      // A directory has no members- command of its own: its media, listed by core.
      const listing = await client.execJson<ContainerListing>(`members ${ALBUMS_ROOT}/imported/files`);
      assertEquals(listing.members.map((member) => member.path).sort(), [`${ALBUMS_ROOT}/imported/files/b1998.jpg`, `${ALBUMS_ROOT}/imported/files/d2010.jpg`]);
    });

    await t.step('album stacks collapse locally and hidden-member filters remap to the front', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'stacked', { attrs: { name: 'Stacked' } });
      await mkmedia(`${ALBUMS_ROOT}/stacked/one.jpg`, { ...captureTime('2012-01-01T00:00:00') });
      await mkmedia(`${ALBUMS_ROOT}/stacked/two.jpg`, { ...captureTime('2012-01-01T00:00:05') });
      await mkmedia(`${ALBUMS_ROOT}/stacked/old.jpg`, { ...captureTime('2011-01-01T00:00:00') });
      const one = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/stacked/one.jpg`);
      const two = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/stacked/two.jpg`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/stacked`, {
        attrs: {
          mediaStacks: {
            version: 1,
            threshold: 0.85,
            maxGapSeconds: 10,
            sourceSignature: 'test',
            computedAt: '2012-01-01T00:01:00Z',
            excludedIds: [],
            groups: [{ frontId: one.id, memberIds: [one.id, two.id] }],
          },
        },
      });

      const collapsed = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/stacked`);
      assertEquals(names(collapsed), ['one.jpg', 'old.jpg']);
      assertEquals(collapsed.results[0].stackCount, 2);
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/stacked --include-stacked`)), ['two.jpg', 'one.jpg', 'old.jpg']);

      const layout = await client.execJson<LayoutResults>(`search --under ${ALBUMS_ROOT}/stacked --layout`);
      assertEquals(layout.layout.items[0][12], 2);
      const facets = await client.execJson<{ total: number; kinds: { kind: string; count: number }[] }>(`search --under ${ALBUMS_ROOT}/stacked --facets`);
      assertEquals(facets.total, 2);
      assertEquals(facets.kinds, [{ kind: 'photo', count: 2 }]);

      await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'burst-person', { attrs: { name: 'Burst person' } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/stacked/two.jpg`, 'people', { props: { mode: 0o775 } });
      await mklink(`${ALBUMS_ROOT}/stacked/two.jpg/people`, 'burst-person', `${PEOPLE_ROOT}/burst-person`);
      const filtered = await client.execJson<Results>(`search --subject person:burst-person --under ${ALBUMS_ROOT}/stacked`);
      assertEquals(filtered.results.map((hit) => [hit.path, hit.stackCount]), [[`${ALBUMS_ROOT}/stacked/one.jpg`, 2]]);

      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'same-photos', { attrs: { name: 'Same photos' } });
      await mklink(`${ALBUMS_ROOT}/same-photos`, 'one', `${ALBUMS_ROOT}/stacked/one.jpg`);
      await mklink(`${ALBUMS_ROOT}/same-photos`, 'two', `${ALBUMS_ROOT}/stacked/two.jpg`);
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/same-photos`)), ['two.jpg', 'one.jpg']);

      // The command's own answer: the hidden photo names its front, the front its stack's size.
      const listing = await client.execJson<ContainerListing>(`members-album ${ALBUMS_ROOT}/stacked`);
      const byName = new Map(listing.members.map((member) => [member.path.split('/').pop(), member]));
      assertEquals(byName.get('two.jpg')?.front, `${ALBUMS_ROOT}/stacked/one.jpg`);
      assertEquals(byName.get('one.jpg')?.stackCount, 2);
      assertEquals(byName.get('old.jpg')?.front, undefined);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
