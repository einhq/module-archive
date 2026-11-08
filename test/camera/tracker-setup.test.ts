/**
 * tracker-setup: a camera's live-tracking link, turned on (giving the camera a track when it has
 * none), shown again, replaced and turned off; with `--origin`, the full URL and a QR code that
 * names the camera to Traccar Client. A phone posting to the URL adds to the camera's track.
 */

import { CAMERAS_ROOT } from '@archive/paths';
import { assert, assertEquals, assertMatch, assertNotEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import type { TrackerSetup } from '@archive/camera/api';

const testCtx = createTestContext({ modules: ['archive'] });

const ORIGIN = 'https://ein.example';

Deno.test({
  name: 'tracker-setup',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const camera = `${CAMERAS_ROOT}/sailboat`;

  try {
    await cmd.shouldSucceed(`mknode -p -t camera ${camera} --as name=Sailboat`);

    await t.step('off until turned on, and asking makes no track', async () => {
      assertEquals(await client.execJson<TrackerSetup>('tracker-setup sailboat'), { camera, track: `${camera}/track`, enabled: false });
      assertEquals((await client.exec(`stat ${camera}/track`)).success, false);
    });

    let first: TrackerSetup;
    await t.step('--new gives the camera a track and a link, with the QR code naming the camera', async () => {
      first = await client.execJson<TrackerSetup>(`tracker-setup sailboat --new --origin ${ORIGIN}/cameras/sailboat`);
      assertEquals(first.enabled, true);
      assertMatch(first.url!, /^https:\/\/ein\.example\/tracker\/[0-9A-Z]{26}\.[A-Za-z0-9]{22}$/);
      assertEquals(first.qrText, `${first.url}?id=sailboat`);
      assertStringIncludes(first.qrSvg!, '<svg');

      const shown = await client.execJson<TrackerSetup>('tracker-setup sailboat');
      assertEquals(shown.url, new URL(first.url!).pathname);
      assertEquals(shown.qrSvg, undefined);
    });

    await t.step('a phone posting to the link adds to the track', async () => {
      const res = await fetch(`${baseUrl}${new URL(first.url!).pathname}?id=sailboat&lat=57.5&lon=11.9&timestamp=1717236000`);
      assertEquals(await res.json(), { appended: 1, skipped: 0 });
      assertEquals((await client.execJson<{ points: number }>(`file-stat ${camera}/track`)).points, 1);
    });

    await t.step('--new replaces the link, --off turns it off', async () => {
      const second = await client.execJson<TrackerSetup>(`tracker-setup ${camera} --new --origin ${ORIGIN}`);
      assertNotEquals(second.url, first.url);
      assertEquals(await client.execJson<TrackerSetup>('tracker-setup sailboat --off'), { camera, track: `${camera}/track`, enabled: false });
      const res = await fetch(`${baseUrl}${new URL(second.url!).pathname}?lat=1&lon=2`);
      assertEquals(res.status, 403);
      await res.body?.cancel();
    });

    await t.step('a bad origin or both flags are refused', async () => {
      await cmd.shouldFailWith('tracker-setup sailboat --origin not-a-url', '--origin takes a URL');
      await cmd.shouldFailWith('tracker-setup sailboat --new --off', 'do not go together');
      assert((await client.exec('tracker-setup nosuchcamera')).success === false);
    });
  } finally {
    client.close();
  }
});
