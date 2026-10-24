/**
 * `search --under` a directory: its media and what its links point at, one level
 * deep. Covers softlink members and their member links, ordering, paging and
 * combination with the other facets. An album's own rules — its `files/` layout,
 * its cover link, its stacks — are the media area's, and are tested there.
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Hit = { path: string; memberPath?: string; name: string; takenAt?: string; stackCount?: number; pinned?: true };
type Results = { results: Hit[]; truncated: boolean; cursor: string | null; filters: Record<string, unknown> };
type LayoutRow = [number, string, number, string, string, number, number, string, number, number, number, number, number, number, number, number];
type LayoutResults = {
  truncated: boolean;
  cursor: null;
  layout: { directories: string[]; mimetypes: string[]; ownerships: { mode: number; uid: number; gid: number }[]; items: LayoutRow[] };
};

const names = (r: Results) => r.results.map((e) => e.path.split('/').pop());
const layoutPaths = (r: LayoutResults) => r.layout.items.map((row) => `${r.layout.directories[row[0]]}/${row[1]}`);
const layoutMemberPaths = (r: LayoutResults) => r.layout.items.map((row) => row[2] < 0 ? undefined : `${r.layout.directories[row[2]]}/${row[3]}`);

Deno.test({
  name: 'search containers',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
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
    // A flat album: media as direct children.
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/flat`);
    await mkmedia(`${ALBUMS_ROOT}/flat/a1995.jpg`, { ...captureTime('1995-06-01T10:00:00') });
    await mkmedia(`${ALBUMS_ROOT}/flat/c2001.jpg`, { name: 'New year', ...captureTime('2001-01-01T00:00:00'), width: 4000, height: 3000, angle: 90 });
    await mkmedia(`${ALBUMS_ROOT}/flat/undated.jpg`, {});

    // An imported album: everything under files/.
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/imported/files`);
    await mkmedia(`${ALBUMS_ROOT}/imported/files/b1998.jpg`, { ...captureTime('1998-03-12T08:30:00') });
    await mkmedia(`${ALBUMS_ROOT}/imported/files/d2010.jpg`, { ...captureTime('2010-05-05T12:00:00') });

    await t.step('lists a flat album newest first, undated last', async () => {
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`)), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat --sort time`)), ['a1995.jpg', 'c2001.jpg', 'undated.jpg']);
      // `--sort -time` is what the UI sends, and its value starts with a dash.
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat --sort -time`)), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
    });

    await t.step('a directory is listed one level deep; a lone files/ child is an album rule, not this', async () => {
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/imported/files`)), ['d2010.jpg', 'b1998.jpg']);
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/imported`)), []);
    });

    await t.step('resolves a relative path against the cwd', async () => {
      assertEquals(names(await client.execJson<Results>(`cd ${ALBUMS_ROOT} && search --under flat`)), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
    });

    await t.step('follows softlink members, so a directory of links works', async () => {
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/auto`);
      await mklink(`${ALBUMS_ROOT}/auto`, 'm0', `${ALBUMS_ROOT}/flat/a1995.jpg`);
      await mklink(`${ALBUMS_ROOT}/auto`, 'm1', `${ALBUMS_ROOT}/imported/files/d2010.jpg`);

      const res = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/auto`);
      assertEquals(names(res), ['d2010.jpg', 'a1995.jpg']);
      // Members keep their own path, not one under the album.
      assertEquals(res.results.map((r) => r.path), [`${ALBUMS_ROOT}/imported/files/d2010.jpg`, `${ALBUMS_ROOT}/flat/a1995.jpg`]);
      // And the link that files them here, which is the only way to unfile one.
      assertEquals(res.results.map((r) => r.memberPath), [`${ALBUMS_ROOT}/auto/m1`, `${ALBUMS_ROOT}/auto/m0`]);

      const layout = await client.execJson<LayoutResults>(`search --under ${ALBUMS_ROOT}/auto --layout`);
      assertEquals(layoutPaths(layout), [`${ALBUMS_ROOT}/imported/files/d2010.jpg`, `${ALBUMS_ROOT}/flat/a1995.jpg`]);
      assertEquals(layoutMemberPaths(layout), [`${ALBUMS_ROOT}/auto/m1`, `${ALBUMS_ROOT}/auto/m0`]);
      assertEquals(layout.cursor, null);
      assertEquals(layout.truncated, false);
    });

    await t.step('layout carries the complete ordered geometry without repeated keys', async () => {
      const layout = await client.execJson<LayoutResults>(`search --under ${ALBUMS_ROOT}/flat --layout`);
      assertEquals(layoutPaths(layout), [`${ALBUMS_ROOT}/flat/c2001.jpg`, `${ALBUMS_ROOT}/flat/a1995.jpg`, `${ALBUMS_ROOT}/flat/undated.jpg`]);
      assertEquals(layout.layout.directories, [`${ALBUMS_ROOT}/flat`]);
      assertEquals(layout.layout.mimetypes, ['image/jpeg']);

      const newest = layout.layout.items[0];
      assertEquals(newest[4], 'New year');
      // takenAt, width, height, angle, duration, stackCount, sar, ownership, pinned — each
      // appended, never inserted, so an older decoder still reads the fields it knows.
      assertEquals(newest.slice(7), ['2001-01-01T00:00:00', 4000, 3000, 90, 0, 0, 0, 0, 0]);
      const ownership = layout.layout.ownerships[newest[14]];
      assertEquals(typeof ownership.mode, 'number');
    });

    await t.step('says which media keeps its own sharing, in a hit and in the layout', async () => {
      await cmd.shouldSucceed(`share-set --pin ${ALBUMS_ROOT}/flat/a1995.jpg`);

      const res = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`);
      assertEquals(res.results.map((r) => r.pinned), [undefined, true, undefined]);
      const layout = await client.execJson<LayoutResults>(`search --under ${ALBUMS_ROOT}/flat --layout`);
      assertEquals(layout.layout.items.map((row) => row[15]), [0, 1, 0]);

      await cmd.shouldSucceed(`share-set --unpin ${ALBUMS_ROOT}/flat/a1995.jpg`);
      assertEquals((await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`)).results.map((r) => r.pinned), [undefined, undefined, undefined]);
    });

    await t.step('layout uses the same filters and rejects non-materialized drivers', async () => {
      const narrowed = await client.execJson<LayoutResults>(`search --under ${ALBUMS_ROOT}/flat --layout --from 2000`);
      assertEquals(layoutPaths(narrowed), [`${ALBUMS_ROOT}/flat/c2001.jpg`]);
      assertEquals((await client.exec('JSON_OUTPUT=1 search --layout')).success, false);
      assertEquals((await client.exec(`JSON_OUTPUT=1 search boat --under ${ALBUMS_ROOT}/flat --layout`)).success, false);
    });

    await t.step('a file that lives in the container has no memberPath', async () => {
      const res = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`);
      assertEquals(res.results.map((r) => r.memberPath), [undefined, undefined, undefined]);
    });

    await t.step('reports the member link when something else drives the query', async () => {
      await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}`);
      await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'bea', { attrs: { name: 'Bea' } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/flat/c2001.jpg`, 'people', { props: { mode: 0o775 } });
      await mklink(`${ALBUMS_ROOT}/flat/c2001.jpg/people`, 'bea', `${PEOPLE_ROOT}/bea`);
      await mklink(`${ALBUMS_ROOT}/auto`, 'm2', `${ALBUMS_ROOT}/flat/c2001.jpg`);

      // The subject drives and the container degrades to a membership test, so the
      // link has to survive that path too — the page still offers to unfile it.
      const res = await client.execJson<Results>(`search --subject person:bea --under ${ALBUMS_ROOT}/auto`);
      assertEquals(res.results.map((r) => r.path), [`${ALBUMS_ROOT}/flat/c2001.jpg`]);
      assertEquals(res.results.map((r) => r.memberPath), [`${ALBUMS_ROOT}/auto/m2`]);
    });

    await t.step('removing the member link unfiles the photo and keeps the file', async () => {
      const before = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/auto`);
      const member = before.results.find((r) => r.path === `${ALBUMS_ROOT}/flat/a1995.jpg`)?.memberPath;
      assertEquals(member, `${ALBUMS_ROOT}/auto/m0`);

      await cmd.shouldSucceed(`rm -rf ${member}`);

      const after = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/auto`);
      assert(!after.results.some((r) => r.path === `${ALBUMS_ROOT}/flat/a1995.jpg`), 'the member is gone from the album');
      // The photo itself is untouched — the whole point of the second identity.
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat/a1995.jpg`), 'the file it pointed at survives');
    });

    await t.step('subdirectories are not recursed', async () => {
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/flat/sub`);
      await mkmedia(`${ALBUMS_ROOT}/flat/sub/deep.jpg`, { ...captureTime('2020-01-01T00:00:00') });

      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`)), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
    });

    await t.step('renditions in the album are never results', async () => {
      await mkmedia(`${ALBUMS_ROOT}/flat/thumb.webp`, { mimetype: 'image/webp', ...captureTime('2001-01-01T00:00:00'), sourceId: 'c2001-original' });

      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`)), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
    });

    await t.step('pages with a cursor, without gaps or repeats', async () => {
      const first = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat -l 2`);
      assertEquals(names(first), ['c2001.jpg', 'a1995.jpg']);
      assert(first.cursor, 'expected a cursor while results remain');

      const second = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat -l 2 --cursor ${first.cursor}`);
      assertEquals(names(second), ['undated.jpg']);
      assertEquals(second.cursor, null);
    });

    await t.step('combines with the other facets', async () => {
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat --from 2000`)), ['c2001.jpg']);
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat --kind photo`)), ['c2001.jpg', 'a1995.jpg', 'undated.jpg']);
      assertEquals(names(await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat --kind video`)), []);

      // A subject drives; the album degrades to a membership test over its hits.
      await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}`);
      await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna', { attrs: { name: 'Anna' } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/flat/a1995.jpg`, 'people', { props: { mode: 0o775 } });
      await mklink(`${ALBUMS_ROOT}/flat/a1995.jpg/people`, 'anna', `${PEOPLE_ROOT}/anna`);
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${ALBUMS_ROOT}/imported/files/d2010.jpg`, 'people', { props: { mode: 0o775 } });
      await mklink(`${ALBUMS_ROOT}/imported/files/d2010.jpg/people`, 'anna', `${PEOPLE_ROOT}/anna`);

      assertEquals(names(await client.execJson<Results>(`search --subject person:anna --under ${ALBUMS_ROOT}/flat`)), ['a1995.jpg']);
      assertEquals(names(await client.execJson<Results>(`search --subject person:anna --under ${ALBUMS_ROOT}/imported/files`)), ['d2010.jpg']);
    });

    await t.step('--facets reports which kinds the container holds', async () => {
      type Facets = { total: number; years: { year: number; count: number }[]; kinds: { kind: string; count: number }[] };

      // Undated media counts in both the answer and its kind, but has no year.
      // A type filter has to offer `photo` for an album of undated scans.
      const flat = await client.execJson<Facets>(`search --under ${ALBUMS_ROOT}/flat --facets`);
      assertEquals(flat.total, 3);
      assertEquals(flat.kinds, [{ kind: 'photo', count: 3 }]);

      // A mixed album offers both, biggest first, and nothing it does not hold.
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/mixed`);
      await mkmedia(`${ALBUMS_ROOT}/mixed/p1.jpg`, { ...captureTime('2004-01-01T00:00:00') });
      await mkmedia(`${ALBUMS_ROOT}/mixed/p2.jpg`, { ...captureTime('2004-01-02T00:00:00') });
      await mkmedia(`${ALBUMS_ROOT}/mixed/clip.mp4`, { mimetype: 'video/mp4', ...captureTime('2004-01-03T00:00:00') });

      const mixed = await client.execJson<Facets>(`search --under ${ALBUMS_ROOT}/mixed --facets`);
      assertEquals(mixed.kinds, [{ kind: 'photo', count: 2 }, { kind: 'video', count: 1 }]);

      // Narrowed to one kind, only that kind is counted — which is why the album
      // page asks without one, so its options cannot delete themselves.
      const photos = await client.execJson<Facets>(`search --under ${ALBUMS_ROOT}/mixed --facets --kind video`);
      assertEquals(photos.kinds, [{ kind: 'video', count: 1 }]);
    });

    await t.step('reports the container it filtered on', async () => {
      const res = await client.execJson<Results>(`search --under ${ALBUMS_ROOT}/flat`);
      assertEquals(res.filters.under, `${ALBUMS_ROOT}/flat`);
    });

    await t.step('an unknown container is an error, not an empty result', async () => {
      assertEquals((await client.exec(`search --under ${ALBUMS_ROOT}/nope`)).success, false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
