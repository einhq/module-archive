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
        assertEquals(blocked, { scanned: 0, emitted: 0, budget: 0, complete: false, cursor, paths: [], held: [] });
        assertEquals((await vfs.get(ADMIN_ACCESS, ALBUMS_ROOT)).attrs.mediaScanCursor, cursor);
      });
    }

    await t.step('0 lifts the caps: a scan walks the whole tree past ready triggers', async () => {
      // The ready trigger the steps above left would stop a capped scan before it started.
      const capped = await client.execJson<{ scanned: number }>(`media-scan ${ALBUMS_ROOT} -n --restart --max-active 1`);
      assertEquals(capped.scanned, 0);
      const all = await client.execJson<{ scanned: number; budget: number | null; complete: boolean }>(
        `media-scan ${ALBUMS_ROOT} -n --restart --scan-limit 0 --limit 0 --max-active 0`,
      );
      assertEquals(all.complete, true);
      assertEquals(all.scanned > 0, true, `scanned ${all.scanned}`);
      // No cap is no number; JSON writes the unbounded budget as null.
      assertEquals(all.budget, null);
    });

    await t.step('--if-idle holds back only the facts whose pipelines have work ready', async () => {
      const root = '/idle-pools';
      const env = `POOLS_PATH=${root} `;
      await client.exec(`mkdir -p ${root}`);
      for (const pool of ['triggers', 'media']) assertEquals((await client.exec(`mknode -t pool ${root}/${pool}`)).success, true);
      const write = async (file: string, body: string) => {
        await client.exec(`mkfile ${file}`);
        const handle = await vfs.open(ADMIN_ACCESS, file, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(body));
        } finally {
          await handle.close();
        }
      };
      // An unindexed picture, which a scan announces as discovered.
      const album = `${ALBUMS_ROOT}/idle`;
      await client.exec(`mkdir -p ${album}`);
      await write(`${album}/q.jpg`, 'not really a jpeg');
      await vfs.update(ADMIN_ACCESS, `${album}/q.jpg`, { attrs: { mimetype: 'image/jpeg' } });
      // The pipelines the facts below start: discovery's, the voices' on another media kind, and
      // the fingerprint's, which nothing below keeps busy.
      await client.exec('mkdir -p /tmp/defs');
      for (const name of ['media-ingest', 'media-voiceprint', 'media-fingerprint']) {
        await write(`/tmp/defs/${name}.yaml`, await Deno.readTextFile(new URL(`../../pipelines/${name}.yaml`, import.meta.url)));
        assertEquals((await client.exec(`pipeline define /tmp/defs/${name}.yaml`)).success, true, `define ${name}`);
      }
      type Scan = { scanned: number; emitted: number; held: string[]; waiting?: boolean };
      const scan = (only = '') => client.execJson<Scan>(`${env}media-scan ${album} -n --restart --if-idle --max-active 0 --limit 0${only}`);

      const idle = await scan();
      assertEquals([idle.waiting, idle.held], [undefined, []]);
      assertEquals(idle.emitted > 0, true, `emitted ${idle.emitted}`);

      // A live tracker's debounced trip run, ready for as long as it sends, and a backlog of
      // another media kind: neither is the work an unindexed file's discovery starts.
      await vfs.poolAdd(ADMIN_ACCESS, `${root}/triggers`, { kind: 'track-trips', params: {} });
      await vfs.poolAdd(ADMIN_ACCESS, `${root}/media`, { kind: 'diarize', params: {} });
      const past = await scan();
      assertEquals([past.waiting, past.held, past.emitted], [undefined, [], idle.emitted]);

      // Discovery's own work waiting holds its facts back and names them; the scan still walks.
      await vfs.poolAdd(ADMIN_ACCESS, `${root}/media`, { kind: 'ingest', params: {} });
      const held = await scan();
      assertEquals(held.waiting, undefined);
      assertEquals(held.held, ['media.file.discovered']);
      assertEquals(held.scanned, idle.scanned);

      // Nothing is walked when every type it may announce waits.
      const only = await scan(' --only media.file.discovered');
      assertEquals([only.waiting, only.scanned], [true, 0]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
