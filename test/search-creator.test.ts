/**
 * `search --creator`: media by the user who created the node.
 *
 * The feed's "My" scope. The creating uid is a node column, so the filter must
 * ride inside the store query when the timeline drives — the `--max-scan 1`
 * probe is what proves it does — and post-filter only when a more selective
 * source (a tag here) drives instead.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Results = { results: { path: string }[]; cursor: string | null; filters: { creator: number | null } };
type Facets = { total: number; truncated: boolean; years: { year: number; count: number }[] };
const paths = (r: Results) => r.results.map((e) => e.path);

Deno.test({
  name: 'search --creator',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await cmd.shouldSucceed('user-create alice --uid 3000');
    await cmd.shouldSucceed('user-passwd alice --new-password hunter2');
    await client.exec('mkdir -p /media && chmod 777 /media');

    // Admin adds two, alice adds two; one of hers is undated.
    await client.exec('echo a > /media/admin-old.jpg && echo b > /media/admin-new.jpg');
    const alice = await testCtx.server.createShellClient({ username: 'alice', password: 'hunter2' });
    try {
      await alice.exec('echo c > /media/alice-2019.jpg && echo d > /media/alice-2021.jpg && echo e > /media/alice-undated.jpg');
    } finally {
      alice.close();
    }

    await vfs.update(ADMIN_ACCESS, '/media/admin-old.jpg', { attrs: { ...captureTime('2015-06-01T12:00:00'), mimetype: 'image/jpeg' } });
    await vfs.update(ADMIN_ACCESS, '/media/admin-new.jpg', { attrs: { ...captureTime('2022-08-15T09:30:00'), mimetype: 'image/jpeg' } });
    await vfs.update(ADMIN_ACCESS, '/media/alice-2019.jpg', { attrs: { ...captureTime('2019-03-03T10:00:00'), mimetype: 'image/jpeg' } });
    await vfs.update(ADMIN_ACCESS, '/media/alice-2021.jpg', { attrs: { ...captureTime('2021-07-07T10:00:00'), mimetype: 'image/jpeg' } });
    await vfs.update(ADMIN_ACCESS, '/media/alice-undated.jpg', { attrs: { mimetype: 'image/jpeg' } });

    await cmd.shouldSucceed('label add /media/alice-2019.jpg vacation');
    await cmd.shouldSucceed('label add /media/admin-new.jpg vacation');

    await t.step('a creator by name or uid lists only their dated media, newest first', async () => {
      const byName = await client.execJson<Results>('search --creator alice');
      assertEquals(paths(byName), ['/media/alice-2021.jpg', '/media/alice-2019.jpg']);
      assertEquals(byName.filters.creator, 3000);

      const byUid = await client.execJson<Results>('search --creator 3000');
      assertEquals(paths(byUid), paths(byName));
    });

    await t.step('the creator is pushed into the store query, not scanned for', async () => {
      // With a scan budget of one row, a post-filter would examine the newest
      // node (admin's) and stop. The store query only ever yields alice's rows.
      const res = await client.execJson<Results>('search --creator alice --max-scan 1 -l 1');
      assertEquals(paths(res), ['/media/alice-2021.jpg']);

      const withKind = await client.execJson<Results>('search --creator alice --kind photo --max-scan 1 -l 1');
      assertEquals(paths(withKind), ['/media/alice-2021.jpg']);
    });

    await t.step('paging by cursor continues the same creator', async () => {
      const first = await client.execJson<Results>('search --creator alice -l 1');
      assertEquals(paths(first), ['/media/alice-2021.jpg']);
      const second = await client.execJson<Results>(`search --creator alice -l 1 --cursor '${first.cursor}'`);
      assertEquals(paths(second), ['/media/alice-2019.jpg']);
    });

    await t.step('facets are counted in the store and are exact', async () => {
      const facets = await client.execJson<Facets>('search --creator alice --facets --max-scan 1');
      assertEquals(facets.total, 2);
      assertEquals(facets.truncated, false);
      assertEquals(facets.years.map((y) => y.year), [2019, 2021]);
    });

    await t.step('a creator intersects with a driving tag', async () => {
      const res = await client.execJson<Results>('search --tag vacation --creator alice');
      assertEquals(paths(res), ['/media/alice-2019.jpg']);
      const admin = await client.execJson<Results>('search --tag vacation --creator admin');
      assertEquals(paths(admin), ['/media/admin-new.jpg']);
    });

    await t.step('an unknown creator is an error, not an empty answer', async () => {
      await cmd.shouldFail('search --creator nobody-here');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
