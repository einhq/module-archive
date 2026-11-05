/**
 * A pass of `media-scan` runs as the media-heal pipeline in a booted EiN: `media-heal` announces
 * it, the engine runs it as one instance on the albums root, the step's output says what the pass
 * found, and the pass after one that held types back is over those types alone.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import type { MediaHealAnswer } from '@archive/media/api';
import type { PipelineInstanceStatus } from '@ein/api';
import { PIPELINE_INSTANCES_PATH } from '@ein/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { startStubEms } from '@ems/testing';

/** How long after a pass a fact for the same subject is taken for the pass's own (the engine's self-trigger grace). */
const SELF_TRIGGER_GRACE_MS = 5000;

Deno.test({ name: 'a heal pass is a pipeline instance', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  // A pass waits for an EMS that says what it runs now. The service's own first announcement may
  // run beside the test's; the interval keeps it to one.
  const ems = startStubEms({ capabilities: { signatures: { transcribe: 'whisper-test' } } });
  const testCtx = createTestContext({ modules: ['archive'], boot: true, env: { CFG_MEDIA_HEAL_INTERVAL: '3600', CFG_EMS_URL: ems.url } });
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    const rootId = (await vfs.get(ADMIN_ACCESS, ALBUMS_ROOT)).id;
    const instance = `${PIPELINE_INSTANCES_PATH}/media-heal/${rootId}`;
    /** The pass on the albums root once it has finished after `after`. */
    const finished = async (after: number): Promise<PipelineInstanceStatus> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const attrs = await vfs.get(ADMIN_ACCESS, instance).then((node) => node.attrs as { status: string; completedAt?: number }, () => undefined);
        if (attrs?.status === 'completed' && (attrs.completedAt ?? 0) > after) return await client.execJson<PipelineInstanceStatus>(`pipeline status ${rootId}`);
        if (attrs?.status === 'failed') throw new Error(`the pass failed: ${JSON.stringify(await client.execJson(`pipeline status ${rootId}`))}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('timed out waiting for the pass');
    };

    let completedAt = 0;
    await t.step('an announced pass runs as one instance whose step says what it found', async () => {
      const announced = await client.execJson<MediaHealAnswer>('media-heal --rest 0');
      assertEquals(['due', 'running'].includes(announced.reason), true, JSON.stringify(announced));
      const status = await finished(0);
      completedAt = status.completedAt!;
      assertEquals(status.triggerPath, ALBUMS_ROOT);
      assertEquals(status.triggerEvent?.data, { only: '' });
      const [scan] = status.steps;
      assertEquals([scan.stepName, scan.status], ['scan', 'completed']);
      assertStringIncludes(scan.output ?? '', 'pass complete');
      const last = (await vfs.get(ADMIN_ACCESS, ALBUMS_ROOT)).attrs.mediaScanLast as { at: number };
      assertEquals(typeof last.at, 'number');
    });

    await t.step('the pass after one that held types back is over those alone', async () => {
      await vfs.update(ADMIN_ACCESS, ALBUMS_ROOT, { attrs: { mediaScanLast: { at: Date.now(), scanned: 0, emitted: 0, held: ['media.picture.stale'] } } });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, completedAt + SELF_TRIGGER_GRACE_MS + 100 - Date.now())));
      assertEquals(await client.execJson<MediaHealAnswer>('media-heal'), { announced: true, reason: 'due', only: ['media.picture.stale'] });
      const status = await finished(completedAt);
      assertEquals(status.triggerEvent?.data, { only: 'media.picture.stale' });
      assertEquals(status.steps[0].status, 'completed');
      // Nothing was held back this time, and nothing found: the next is a rest.
      assertEquals((await client.execJson<MediaHealAnswer>('media-heal')).reason, 'resting');
    });
  } finally {
    client.close();
    await testCtx.teardown();
    await ems.close();
  }
});
