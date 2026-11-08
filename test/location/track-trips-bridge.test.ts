/**
 * The booted chain behind a track's trips: points appended to a track under the archive reach
 * archive-bridge, which announces `track.changed` for the track on /dev/events.
 */

import { LOCATION_EVENTS } from '@archive/location/event-rules';
import { assertEquals } from '@std/assert';
import { EVENTS_ROUTING_KEY } from '@ein/client';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { historyOf, mkTracker } from './tracker.ts';

const testCtx = createTestContext({ modules: ['archive'], boot: true });

Deno.test({
  name: 'archive bridge, track facts',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const track = historyOf('the-tracker');

  try {
    await client.exec(mkTracker('the-tracker'));

    await t.step('points appended to a track announce track.changed for the track', async () => {
      await vfs.create(ADMIN_ACCESS, 'router', '/tmp', 'events-tail', { attrs: { routingKey: EVENTS_ROUTING_KEY } });
      const handle = await vfs.open(ADMIN_ACCESS, '/tmp/events-tail', { mode: 'r' });
      try {
        const signal = AbortSignal.timeout(15000);
        const changed = (async () => {
          for (;;) {
            const data = await handle.read(1, signal);
            if (data.length === 0) return undefined;
            const fact = JSON.parse(new TextDecoder().decode(data).trim());
            if (fact.type === LOCATION_EVENTS.trackChanged) return fact;
          }
        })();

        await client.exec(`track-append ${track} --lat=59.1 --lng=18.1 --ts 2025-06-01T10:00:00Z`);
        const fact = await changed;
        assertEquals([fact?.subject, fact?.data?.cause], [track, 'points']);
      } finally {
        await handle.close();
      }
    });
  } finally {
    await testCtx.teardown();
  }
});
