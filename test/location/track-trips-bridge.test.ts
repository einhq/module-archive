/**
 * The booted chain behind a track's trips: points appended to a device's track under `/dev`, by
 * hand or by its driver reading what is written to the device, and its device's class changing,
 * reach archive-bridge, which announces `track.changed` for the track on /dev/events.
 */

import { LOCATION_EVENTS } from '@archive/location/event-rules';
import { assertEquals } from '@std/assert';
import { EVENTS_ROUTING_KEY } from '@ein/client';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { deviceAt, mkTracker, positionOf } from './tracker.ts';

const testCtx = createTestContext({ modules: ['archive'], boot: true });

Deno.test({
  name: 'archive bridge, track facts',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const track = positionOf('the-tracker');

  try {
    await client.exec(mkTracker('the-tracker'));

    await vfs.create(ADMIN_ACCESS, 'router', '/tmp', 'events-tail', { attrs: { routingKey: EVENTS_ROUTING_KEY } });

    /** The next `track.changed` on /dev/events after `write` runs. */
    const nextChange = async (write: () => Promise<unknown>) => {
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
        await write();
        return await changed;
      } finally {
        await handle.close();
      }
    };

    await t.step('points appended to a track announce track.changed for the track', async () => {
      const fact = await nextChange(() => client.exec(`track-append ${track} --lat=59.1 --lng=18.1 --ts 2025-06-01T10:00:00Z`));
      assertEquals([fact?.subject, fact?.data?.cause], [track, 'points']);
    });

    await t.step('a fix written to the device announces track.changed for its track', async () => {
      const fix = JSON.stringify({ lat: 59.2, lng: 18.2, ts: '2025-06-01T11:00:00Z' });
      const fact = await nextChange(() => client.exec(`echo '${fix}' > ${deviceAt('the-tracker')}`));
      assertEquals([fact?.subject, fact?.data?.cause], [track, 'points']);
    });

    await t.step("its device's class changing announces track.changed for its track", async () => {
      const fact = await nextChange(() => client.exec(`attrs ${deviceAt('the-tracker')} -s class=boat`));
      assertEquals([fact?.subject, fact?.data?.cause], [track, 'class']);
    });
  } finally {
    await testCtx.teardown();
  }
});
