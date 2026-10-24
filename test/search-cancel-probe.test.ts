/**
 * A search cancelled while it asks its providers `--kinds` leaves them providers: the hung-up
 * probe is not remembered as "not a provider" for the rest of the instance.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

Deno.test({
  name: 'search cancelled during the provider probe',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const setup = await testCtx.server.createShellClient();

  await setup.exec('mkdir -p /media && echo x > /media/a.jpg');
  await vfs.update(ADMIN_ACCESS, '/media/a.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('2001-01-01T00:00:00') } });

  // Slow to say what it is, so the cancel lands inside the probe.
  await setup.exec('mkdir -p /opt/bin && mkfile /opt/bin/search-slowprobe && chmod 755 /opt/bin/search-slowprobe');
  const handle = await vfs.open(ADMIN_ACCESS, '/opt/bin/search-slowprobe', { mode: 'w' });
  try {
    await handle.write(
      new TextEncoder().encode(
        `[ "$1" = --kinds ] && sleep 1 > /dev/null && echo '{"kinds":["photo"]}' && exit 0\n` +
          `echo '${JSON.stringify({ results: [{ path: '/media/a.jpg', channel: 'picture', score: 0.9 }] })}'\n`,
      ),
    );
  } finally {
    await handle.close();
  }
  await setup.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
  setup.close();

  const client = await testCtx.server.createShellClient();
  try {
    await t.step('a cancel during the probe ends the search', async () => {
      const controller = new AbortController();
      const search = client.exec(`search 'anything'`, { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      assertEquals((await search).success, false);
    });

    await t.step('the next search still finds the provider', async () => {
      const res = await client.execJson<{ results: { path: string }[] }>(`search 'anything'`);
      assertEquals(res.results.map((hit) => hit.path), ['/media/a.jpg']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
