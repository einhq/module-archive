/**
 * location-link-media: auto-link geotagged files to the location whose shape
 * contains their coordinates (<file>/location softlink), idempotently.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

const SQUARE = [
  { lat: 57.684, lng: 11.942 },
  { lat: 57.684, lng: 11.946 },
  { lat: 57.686, lng: 11.946 },
  { lat: 57.686, lng: 11.942 },
];

type LinkStats = { linked: number; skipped: number; unmatched: number };

Deno.test({
  name: 'location-link-media',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('links files inside a location shape, leaves outsiders', async () => {
      await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/park`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/park/position --polygon '${JSON.stringify(SQUARE)}'`);

      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/trip/files`);
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/trip/files/inside.jpg`);
      await cmd.shouldSucceed(`mknode -t position ${ALBUMS_ROOT}/trip/files/inside.jpg/position`);
      await cmd.shouldSucceed(`position-set ${ALBUMS_ROOT}/trip/files/inside.jpg/position --lat=57.685 --lng=11.944`);

      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/trip/files/outside.jpg`);
      await cmd.shouldSucceed(`mknode -t position ${ALBUMS_ROOT}/trip/files/outside.jpg/position`);
      await cmd.shouldSucceed(`position-set ${ALBUMS_ROOT}/trip/files/outside.jpg/position --lat=59.33 --lng=18.07`);

      const stats = await client.execJson<LinkStats>('location-link-media');
      assertEquals(stats.linked, 1);
      assertEquals(stats.unmatched, 1);

      const link = await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/trip/files/inside.jpg/location`);
      assertEquals(link.softlink, `${LOCATIONS_ROOT}/park`);

      const hasOutsideLink = await client.exec(`props -L ${ALBUMS_ROOT}/trip/files/outside.jpg/location`);
      assertEquals(hasOutsideLink.success, false);
    });

    await t.step('is idempotent (existing links are skipped)', async () => {
      const stats = await client.execJson<LinkStats>('location-link-media');
      assertEquals(stats.linked, 0);
      assertEquals(stats.skipped, 1);
    });

    await t.step('--dry-run reports without creating links', async () => {
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/trip/files/inside.jpg/location`);
      const dry = await client.execJson<LinkStats>('location-link-media --dry-run');
      assertEquals(dry.linked, 1);

      const stillGone = await client.exec(`props -L ${ALBUMS_ROOT}/trip/files/inside.jpg/location`);
      assertEquals(stillGone.success, false);
    });

    await t.step('a shape link is marked as one', async () => {
      await cmd.shouldSucceed('location-link-media');
      const attrs = await client.execJson<{ linkSource?: string }>(`attrs -L ${ALBUMS_ROOT}/trip/files/inside.jpg/location`);
      assertEquals(attrs.linkSource, 'shape');
    });

    await t.step('--point links one file, and a moved point takes its link along', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/square`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/square/position --lat=59.33 --lng=18.07 --radius=100`);

      const one = await client.execJson<LinkStats & { unlinked: number }>(`location-link-media --point ${ALBUMS_ROOT}/trip/files/outside.jpg/position`);
      assertEquals(one.linked, 1);
      assertEquals((await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/trip/files/outside.jpg/location`)).softlink, `${LOCATIONS_ROOT}/square`);

      // Out of every location: the shape link goes.
      await cmd.shouldSucceed(`position-set ${ALBUMS_ROOT}/trip/files/outside.jpg/position --lat=10 --lng=10`);
      const moved = await client.execJson<LinkStats & { unlinked: number }>(`location-link-media --point ${ALBUMS_ROOT}/trip/files/outside.jpg/position`);
      assertEquals(moved.unlinked, 1);
      assertEquals((await client.exec(`props -L ${ALBUMS_ROOT}/trip/files/outside.jpg/location`)).success, false);
    });

    await t.step('--location follows a moved shape, both ways', async () => {
      // The park moves away from inside.jpg: its shape link has to go.
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/park/position --lat=10 --lng=10 --radius=500`);
      const away = await client.execJson<LinkStats & { unlinked: number }>(`location-link-media --location ${LOCATIONS_ROOT}/park`);
      assertEquals(away.unlinked, 1);

      // And back over it: the link returns.
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/park/position --polygon '${JSON.stringify(SQUARE)}'`);
      const back = await client.execJson<LinkStats & { unlinked: number }>(`location-link-media --location ${LOCATIONS_ROOT}/park`);
      assertEquals(back.linked, 1);
    });

    await t.step('a link made by hand is never replaced or removed', async () => {
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/trip/files/inside.jpg/location`);
      await cmd.shouldSucceed(`ln -s ${LOCATIONS_ROOT}/square ${ALBUMS_ROOT}/trip/files/inside.jpg/location`);

      const stats = await client.execJson<LinkStats & { unlinked: number }>(`location-link-media --location ${LOCATIONS_ROOT}/park`);
      assertEquals(stats.linked, 0);
      assertEquals(stats.skipped, 1);
      assertEquals((await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/trip/files/inside.jpg/location`)).softlink, `${LOCATIONS_ROOT}/square`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
