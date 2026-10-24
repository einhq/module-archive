/**
 * Location upkeep end to end, through the boot-wired chain:
 * VFS mutation -> archive-bridge -> /dev/events -> location-upkeep / location-link-point.
 *
 * The real commands run, not stubs — what is under test is that ordinary edits
 * keep locations and photos in step with nobody running a sweep. The locations carry
 * no address or name, so the address fallback has nothing to look up and the
 * test never reaches a geocoder.
 */

import { QUEUES_PATH } from '@ein/paths';
import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'], boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'location upkeep',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const FILES = `${ALBUMS_ROOT}/trip/files`;
  const linkOf = async (file: string): Promise<string | undefined> => {
    try {
      return (await vfs.get(ADMIN_ACCESS, `${file}/location`, { follow: false, readlink: true })).props.softlink;
    } catch {
      return undefined;
    }
  };
  const shapeOf = async (location: string): Promise<{ lat: number; lng: number; radius?: number } | undefined> => {
    const data = (await client.exec(`cat ${location}/position`)).data as unknown;
    if (typeof data === 'string') return data ? JSON.parse(data) : undefined;
    return data && typeof data === 'object' ? data as { lat: number; lng: number } : undefined;
  };
  /** A photo with a GPS point, written the way exif-extract writes one: node first, point after. */
  const photo = async (name: string, lat: number, lng: number) => {
    await client.exec(`mknode -p -t directory ${FILES}/${name}`);
    await client.exec(`mknode -t position ${FILES}/${name}/position`);
    await client.exec(`position-set ${FILES}/${name}/position --lat=${lat} --lng=${lng}`);
  };

  try {
    await client.exec(`mkdir -p ${LOCATIONS_ROOT} && mkdir -p ${FILES}`);

    await t.step('the bridge runs as a module service', async () => {
      const services = await client.execJson<string[]>('ls /etc/services/enabled');
      assertEquals(services.includes('archive-bridge'), true, `services: ${services}`);
      // A mutation published before the bridge has bound its queue reaches nobody.
      await waitFor(() => vfs.exists(ADMIN_ACCESS, `${QUEUES_PATH}/archive-bridge`), 'the bridge queue');
    });

    await t.step('a location given a shape links the photos inside it', async () => {
      await photo('a', 57.7001, 11.9701);
      await photo('far', 59.33, 18.07);
      await client.exec(`mknode -t location ${LOCATIONS_ROOT}/square`);
      await client.exec(`position-set ${LOCATIONS_ROOT}/square/position --lat=57.7 --lng=11.97 --radius=200`);

      await waitFor(async () => await linkOf(`${FILES}/a`) === `${LOCATIONS_ROOT}/square`, 'a to be linked to the square');
      assertEquals(await linkOf(`${FILES}/far`), undefined);
    });

    await t.step('a photo that gets a point inside a location is linked to it', async () => {
      await photo('b', 57.7002, 11.9702);
      await waitFor(async () => await linkOf(`${FILES}/b`) === `${LOCATIONS_ROOT}/square`, 'b to be linked to the square');
    });

    await t.step('moving the location takes its shape links with it', async () => {
      await client.exec(`position-set ${LOCATIONS_ROOT}/square/position --lat=59.33 --lng=18.07 --radius=200`);
      await waitFor(async () => await linkOf(`${FILES}/far`) === `${LOCATIONS_ROOT}/square`, 'far to be linked after the move');
      await waitFor(async () => await linkOf(`${FILES}/a`) === undefined, 'a to lose its shape link');
    });

    await t.step('photos linked by hand location an unplaced location', async () => {
      await client.exec(`mknode -t location ${LOCATIONS_ROOT}/park`);
      await photo('p1', 57.6952, 11.9915);
      await photo('p2', 57.6961, 11.9948);
      await photo('p3', 57.6944, 11.9932);
      for (const name of ['p1', 'p2', 'p3']) await client.exec(`ln -s ${LOCATIONS_ROOT}/park ${FILES}/${name}/location`);

      await waitFor(async () => (await shapeOf(`${LOCATIONS_ROOT}/park`)) !== undefined, 'the park to be placed from its photos');
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/park`);
      assertEquals(attrs.locationSource, 'media-centroid');
      // The hand links are still the hand links.
      assertEquals(await linkOf(`${FILES}/p1`), `${LOCATIONS_ROOT}/park`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
