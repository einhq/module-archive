/** `news-albums`: the albums people made lately, as news entries: who made them, and a glimpse inside in the route that draws them. */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext, testCommands } from '@ein/testing';
import type { NewsEntry, Provided } from '@ein/api';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'news-albums command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('answers with an empty feed when there are no albums', async () => {
      assertEquals(await client.execJson<Provided<NewsEntry>[]>('news-albums'), []);
    });

    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);

    await t.step('rejects a malformed count', async () => {
      await cmd.shouldFailWith('news-albums --limit=abc', '--limit must be a non-negative whole number');
      await cmd.shouldFailWith('news-albums --preview=', '--preview must be a non-negative whole number');
    });

    await t.step('reports who added an album, newest first, with a glimpse inside', async () => {
      const added = async (slug: string, at: string, uid: number) =>
        await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, slug, {
          props: { mode: 0o775, uid, birthtime: { uid, timestamp: Date.parse(at) } },
          attrs: { name: slug },
        });

      await vfs.ensure(ADMIN_ACCESS, 'directory', '/etc/users', 'ada-user', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'user', '/etc/users', 'tora', {
        props: { mode: 0o755 },
        attrs: { uid: 4242, gid: 4242, name: 'Tora Berg' },
      });

      await added('old-trip', '2020-01-01T00:00:00Z', 4242);
      await added('new-trip', '2026-08-30T10:00:00Z', 4242);
      await added('picked', '2026-08-31T10:00:00Z', 4242);

      // Media under `files/`, the imported shape.
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/new-trip`, 'files', { props: { mode: 0o775 } });
      for (const name of ['one.jpg', 'two.jpg']) {
        await vfs.create(ADMIN_ACCESS, 'file', `${ALBUMS_ROOT}/new-trip/files`, name, { props: { mode: 0o644 }, attrs: { mimetype: 'image/jpeg' } });
      }
      // A rendition is not a member.
      await vfs.create(ADMIN_ACCESS, 'file', `${ALBUMS_ROOT}/new-trip/files`, 'one-small.jpg', {
        props: { mode: 0o644 },
        attrs: { mimetype: 'image/jpeg', sourceId: 'one' },
      });
      // A file added to an album is linked there, not held; a relative link resolves against the album.
      const link = async (name: string, target: string) =>
        await vfs.create(ADMIN_ACCESS, 'softlink', `${ALBUMS_ROOT}/picked`, name, { props: { mode: 0o777, softlink: target } });
      await link('member', `${ALBUMS_ROOT}/new-trip/files/one.jpg`);
      await link('relative', '../new-trip/files/two.jpg');
      await link('dangling', `${ALBUMS_ROOT}/new-trip/files/gone.jpg`);

      const result = await client.execJson<Provided<NewsEntry>[]>('news-albums --limit 4');
      assertEquals(result.map((entry) => entry.title), ['Tora Berg added picked', 'Tora Berg added new-trip', 'Tora Berg added old-trip']);
      assertEquals(result.map((entry) => entry.at), [Date.parse('2026-08-31T10:00:00Z'), Date.parse('2026-08-30T10:00:00Z'), Date.parse('2020-01-01T00:00:00Z')]);
      assertEquals(result[1].by, { uid: 4242, username: 'tora', name: 'Tora Berg' });
      assertEquals(result[1].path, `${ALBUMS_ROOT}/new-trip`);

      // The route that draws an entry carries what it shows.
      const query = (entry: Provided<NewsEntry>) => new URL(entry.route, 'http://ein').searchParams;
      assertEquals(new URL(result[1].route, 'http://ein').pathname, '/news/album');
      assertEquals(query(result[1]).get('path'), `${ALBUMS_ROOT}/new-trip`);
      assertEquals(query(result[1]).get('name'), 'new-trip');
      assertEquals(query(result[1]).get('who'), 'Tora Berg');
      assertEquals(query(result[1]).get('count'), '2');
      assertEquals(query(result[1]).getAll('preview'), [`${ALBUMS_ROOT}/new-trip/files/one.jpg`, `${ALBUMS_ROOT}/new-trip/files/two.jpg`]);
      // A linked member previews as its target; a dangling link is not counted.
      assertEquals(query(result[0]).getAll('preview'), [`${ALBUMS_ROOT}/new-trip/files/one.jpg`, `${ALBUMS_ROOT}/new-trip/files/two.jpg`]);
      assertEquals(query(result[0]).get('count'), '2');

      const capped = await client.execJson<Provided<NewsEntry>[]>('news-albums --limit 4 --preview 1');
      assertEquals(query(capped[1]).getAll('preview').length, 1);
      // The cap is on what is shown, not on what was counted.
      assertEquals(query(capped[1]).get('count'), '2');
    });

    await t.step("core's news gathers them, marked as the albums provider's", async () => {
      const news = await client.execJson<NewsEntry[]>('news --limit 2');
      assertEquals(news.map((entry) => [entry.source, entry.title]), [['albums', 'Tora Berg added picked'], ['albums', 'Tora Berg added new-trip']]);
    });

    await t.step('a private album is news only to whoever may read it', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'kept', {
        props: { mode: 0o700, uid: 4242, birthtime: { uid: 4242, timestamp: Date.parse('2026-09-01T10:00:00Z') } },
        attrs: { name: 'kept' },
      });
      await cmd.shouldSucceed('user-create eve');
      await cmd.shouldSucceed('user-passwd eve --new-password secret1');

      assertEquals((await client.execJson<Provided<NewsEntry>[]>('news-albums --limit 1'))[0].title, 'Tora Berg added kept');

      const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        const seen = await eve.execJson<Provided<NewsEntry>[]>('news-albums --limit 4');
        assertEquals(seen.map((entry) => entry.title), ['Tora Berg added picked', 'Tora Berg added new-trip', 'Tora Berg added old-trip']);
      } finally {
        eve.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
