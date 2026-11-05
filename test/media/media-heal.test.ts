/**
 * `media-heal` announces a pass of `media-scan` over the albums root only when one is due, and the
 * fact carries the types the last pass held back. `media-scan` records the pass it finishes on
 * the root it walked, which is what `media-heal` reads.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import type { MediaHealAnswer } from '@archive/media/api';
import { EVENTS_NODE_PATH, PIPELINE_INSTANCES_PATH } from '@ein/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'media-heal announces a pass when one is due', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const pools = '/heal-pools';
  const env = `POOLS_PATH=${pools} `;
  const write = async (file: string, body: string) => {
    await client.exec(`mkfile ${file}`);
    const handle = await vfs.open(ADMIN_ACCESS, file, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };
  const heal = (flags = '') => client.execJson<MediaHealAnswer>(`${env}media-heal${flags}`);
  /** The facts written to the events node since the last call. */
  let seen = 0;
  const announced = async (): Promise<{ type: string; subject: string; lane?: string; data: { only: string } }[]> => {
    const lines = (await client.execString(`cat ${EVENTS_NODE_PATH}`, { json: false })).split('\n').filter(Boolean);
    const fresh = lines.slice(seen).map((line) => JSON.parse(line));
    seen = lines.length;
    return fresh;
  };
  const setRoot = (attrs: Record<string, unknown>) => vfs.update(ADMIN_ACCESS, ALBUMS_ROOT, { attrs });

  try {
    if (!await vfs.exists(ADMIN_ACCESS, EVENTS_NODE_PATH)) assertEquals((await client.exec(`mkdir -p /dev && mkfile ${EVENTS_NODE_PATH}`)).success, true);
    await client.exec(`mkdir -p ${ALBUMS_ROOT} && mkdir -p ${pools} && mkdir -p /tmp/defs`);
    for (const pool of ['triggers', 'media']) assertEquals((await client.exec(`mknode -t pool ${pools}/${pool}`)).success, true);
    // Discovery's pipeline, so a scan has a type whose work may or may not wait.
    await write('/tmp/defs/media-ingest.yaml', await Deno.readTextFile(new URL('../../pipelines/media-ingest.yaml', import.meta.url)));
    assertEquals((await client.exec('pipeline define /tmp/defs/media-ingest.yaml')).success, true);
    await announced();

    await t.step('a first pass is due over every type, in the bulk lane', async () => {
      assertEquals(await heal(' -n'), { announced: false, reason: 'due', only: [] });
      assertEquals(await announced(), []);
      assertEquals(await heal(), { announced: true, reason: 'due', only: [] });
      const [fact, ...more] = await announced();
      assertEquals(more, []);
      assertEquals([fact.type, fact.subject, fact.lane, fact.data], ['media.heal.due', ALBUMS_ROOT, 'bulk', { only: '' }]);
    });

    await t.step('a pass that found nothing is followed by a rest', async () => {
      const at = Date.now();
      await setRoot({ mediaScanLast: { at, scanned: 4, emitted: 0, held: [] } });
      assertEquals(await heal(' --rest 60'), { announced: false, reason: 'resting', only: [], until: at + 60_000 });
      assertEquals(await announced(), []);
      assertEquals((await heal(' --rest 0')).announced, true);
      await announced();
      // One that found something is followed by another without one.
      await setRoot({ mediaScanLast: { at, scanned: 4, emitted: 2, held: [] } });
      assertEquals((await heal(' --rest 60')).reason, 'due');
      await announced();
    });

    await t.step('the pass after one that held types back is over those alone, once their work drains', async () => {
      await setRoot({ mediaScanLast: { at: Date.now(), scanned: 4, emitted: 0, held: ['media.file.discovered'] } });
      await vfs.poolAdd(ADMIN_ACCESS, `${pools}/media`, { kind: 'ingest', params: {} });
      assertEquals(await heal(), { announced: false, reason: 'waiting', only: ['media.file.discovered'] });
      assertEquals(await announced(), []);
      // An unfinished pass goes on regardless: it holds back what waited when it began.
      await setRoot({ mediaScanPass: { cursor: `${ALBUMS_ROOT}/a/b.jpg`, scanned: 1, emitted: 0, held: [] } });
      assertEquals(await heal(), { announced: true, reason: 'unfinished', only: [] });
      assertEquals((await announced()).map((fact) => fact.data), [{ only: '' }]);
      await setRoot({ mediaScanPass: null });

      await vfs.poolCancel(ADMIN_ACCESS, `${pools}/media`, { kind: 'ingest' });
      assertEquals(await heal(), { announced: true, reason: 'due', only: ['media.file.discovered'] });
      assertEquals((await announced()).map((fact) => fact.data), [{ only: 'media.file.discovered' }]);
    });

    await t.step('nothing is announced while a pass runs or after one failed', async () => {
      const rootId = (await vfs.get(ADMIN_ACCESS, ALBUMS_ROOT)).id;
      const instance = `${PIPELINE_INSTANCES_PATH}/media-heal/${rootId}`;
      assertEquals((await client.exec(`mkdir -p ${instance}`)).success, true);
      for (const [status, reason] of [['running', 'running'], ['queued', 'running'], ['failed', 'failed']]) {
        await vfs.update(ADMIN_ACCESS, instance, { attrs: { status } });
        assertEquals((await heal()).reason, reason, status);
      }
      assertEquals(await announced(), []);
      await vfs.update(ADMIN_ACCESS, instance, { attrs: { status: 'completed' } });
      assertEquals((await heal()).announced, true);
    });

    await t.step('media-scan records the pass it finishes, counted over all its runs', async () => {
      const album = `${ALBUMS_ROOT}/recorded`;
      await client.exec(`mkdir -p ${album}`);
      for (const name of ['a.jpg', 'b.jpg']) {
        await write(`${album}/${name}`, 'not really a jpeg');
        await vfs.update(ADMIN_ACCESS, `${album}/${name}`, { attrs: { mimetype: 'image/jpeg' } });
      }
      type Scan = { scanned: number; complete: boolean; pass: { scanned: number; emitted: number; held: string[] } };
      const flags = `${album} --scan-limit 1 --max-active 0 --limit 0`;
      const scan = () => client.execJson<Scan>(`${env}media-scan ${flags}`);
      const first = await scan();
      assertEquals([first.complete, first.pass.scanned], [false, 1]);
      assertEquals((await vfs.get(ADMIN_ACCESS, album)).attrs.mediaScanLast, undefined);
      // A run that stops on the last file leaves the end of the pass to the next one.
      const runs = [first];
      while (!runs.at(-1)!.complete && runs.length < 4) runs.push(await scan());
      const last = runs.at(-1)!;
      assertEquals([last.complete, last.pass.scanned], [true, 2]);
      const recorded = (await vfs.get(ADMIN_ACCESS, album)).attrs as Record<string, unknown>;
      assertEquals(recorded.mediaScanPass, undefined);
      const { at, ...rest } = recorded.mediaScanLast as { at: number };
      assertEquals(rest, last.pass);
      assertEquals(typeof at, 'number');

      // In text, a finished pass is told whole.
      const told: string[] = [];
      while (!told.at(-1)?.includes('pass complete') && told.length < 4) told.push(await client.execString(`${env}media-scan ${flags}`, { json: false }));
      assertEquals(told.at(-1)!.startsWith('Scanned 2 file(s), emitted '), true, told.join(' | '));
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
