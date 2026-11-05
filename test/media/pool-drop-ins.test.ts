/**
 * Set up, the archive's drop-ins are linked where the media module's workers read them: its CPU
 * kinds for the media worker, with the ones after ingest reserved, and its model-bound kinds for
 * the models workers, in their rotation order.
 */

import { assertEquals } from '@std/assert';
import type { PoolKinds } from '@media/api';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'], boot: true });

Deno.test({ name: "the archive's kinds reach the media pool's workers", sanitizeResources: false, sanitizeOps: false }, async () => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  try {
    const cpu = await client.execJson<PoolKinds>('media-pool-kinds cpu');
    // The archive's kinds first, the media module's after them, reading among them.
    assertEquals(cpu.kinds.slice(0, 2), ['unzip', 'interpret']);
    assertEquals([cpu.kinds.includes('ingest'), cpu.reserve.includes('ingest')], [true, false]);
    assertEquals(['stills', 'transcode', 'face-assign'].every((kind) => cpu.reserve.includes(kind)), true);

    const models = await client.execJson<PoolKinds>('media-pool-kinds models');
    assertEquals(models.kinds, ['faces', 'embed-picture', 'ocr', 'embed-text', 'transcribe', 'diarize', 'shots']);
  } finally {
    await testCtx.teardown();
  }
});
