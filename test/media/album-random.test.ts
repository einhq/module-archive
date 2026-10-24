/**
 * `album-random` answers an album of the library, and `null` when there is none, which the top
 * bar's button opens as the albums list.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'album-random', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const random = async () => (await client.execJson<{ path: string | null }>('album-random')).path;

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}`);

    await t.step('none to choose from', async () => {
      assertEquals(await random(), null);
    });

    await t.step('an album under the library root', async () => {
      await client.exec(`album create ${ALBUMS_ROOT}/Summer_2020`);
      for (let i = 0; i < 10; i++) assertEquals(await random(), `${ALBUMS_ROOT}/Summer_2020`);
    });
  } finally {
    await testCtx.teardown();
  }
});
