import { POOLS_PATH } from '@ein/paths';
import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'media hot-path reads and reconciliation backpressure', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  try {
    assertEquals((await client.exec(`mkdir -p ${ALBUMS_ROOT}/hot && mkfile ${ALBUMS_ROOT}/hot/p.jpg`)).success, true);
    const path = `${ALBUMS_ROOT}/hot/p.jpg`;
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', sourceId: 'original' } });
    assertEquals((await client.exec(`mkdir -p ${path}/metadata && mknode -t embedding ${path}/metadata/sscd-image`)).success, true);

    // A shell metadata read would fail these commands. Direct reads still use the caller's
    // access and resolve relative paths against the command's working directory.
    await client.exec('mkdir -p /opt/no-metadata-shell');
    for (const name of ['info', 'attrs']) {
      await client.exec(`echo 'exit 99' > /opt/no-metadata-shell/${name} && chmod 755 /opt/no-metadata-shell/${name}`);
    }
    await client.exec('echo \'export PATH="/opt/no-metadata-shell:$PATH"\' >> /etc/bashrc');

    await t.step('already completed work needs no metadata subshells, including relative paths', async () => {
      for (const name of ['compute-fingerprint', 'generate-derivatives']) {
        const result = await client.exec(`cd ${ALBUMS_ROOT}/hot && ${name} p.jpg`);
        assertEquals(result.success, true, `${name}: ${result.error}`);
      }
      await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'text/plain' } });
      const result = await client.exec(`cd ${ALBUMS_ROOT}/hot && detect-faces p.jpg`);
      assertEquals(result.success, false);
      assertStringIncludes(String(result.error), 'not an image');
    });

    await t.step('missing paths and non-file nodes are still rejected', async () => {
      for (const name of ['compute-fingerprint', 'detect-faces', 'generate-derivatives']) {
        assertEquals((await client.exec(`${name} ${ALBUMS_ROOT}/missing.jpg`)).success, false, name);
        const result = await client.exec(`${name} ${ALBUMS_ROOT}/hot`);
        assertEquals(result.success, false, name);
        assertStringIncludes(String(result.error), 'not a file node');
      }
    });

    for (const root of [POOLS_PATH, '/custom-pools']) {
      await t.step(`ready triggers at ${root} stop reconciliation without advancing its cursor`, async () => {
        await client.exec(`mkdir -p ${root}`);
        if (!await vfs.exists(ADMIN_ACCESS, `${root}/triggers`)) {
          assertEquals((await client.exec(`mknode -t pool ${root}/triggers`)).success, true);
        }
        const cursor = `${ALBUMS_ROOT}/hot/p.jpg`;
        await vfs.update(ADMIN_ACCESS, ALBUMS_ROOT, { attrs: { mediaScanCursor: cursor } });
        const env = root === POOLS_PATH ? '' : `POOLS_PATH=${root} `;
        const before = await client.execJson<{ budget: number }>(`${env}media-scan ${ALBUMS_ROOT} -n --max-active 1`);
        assertEquals(before.budget, 1, 'empty pool must not block a scan');
        await vfs.poolAdd(ADMIN_ACCESS, `${root}/triggers`, { kind: 'media-ingest', params: {} });
        const blocked = await client.execJson<Record<string, unknown>>(`${env}media-scan ${ALBUMS_ROOT} --restart --max-active 1`);
        assertEquals(blocked, { scanned: 0, emitted: 0, budget: 0, complete: false, cursor, paths: [] });
        assertEquals((await vfs.get(ADMIN_ACCESS, ALBUMS_ROOT)).attrs.mediaScanCursor, cursor);
      });
    }
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
