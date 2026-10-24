/**
 * geocode-location end to end, against a stub geocoder on loopback: a confident
 * answer becomes a shape, an uncertain one becomes candidates and no shape.
 */

import { LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals, assertExists } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

const HOUSE = {
  lat: '57.6612',
  lon: '11.9089',
  display_name: 'Exempelgatan 27, Söderby, Göteborg, 999 77, Sverige',
  category: 'building',
  type: 'yes',
  addresstype: 'building',
  importance: 0.32,
  address: { house_number: '27', road: 'Exempelgatan', city: 'Göteborg', postcode: '999 77', country: 'Sverige' },
};

const SUBURB = {
  lat: '57.65',
  lon: '11.91',
  display_name: 'Söderby, Göteborg, Sverige',
  category: 'place',
  addresstype: 'suburb',
  importance: 0.5,
  address: { city: 'Göteborg', country: 'Sverige' },
};

type LocationResult = {
  status: string;
  reason?: string;
  query?: string;
  lat?: number;
  lng?: number;
  candidates?: { lat: number; lng: number }[];
};

Deno.test({
  name: 'geocode-location',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  // Stub Nominatim: answers from the query string, so one server covers every
  // case and the suite never touches the network.
  const queries: string[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    queries.push(q);
    const body = q.includes('Exempelgatan 27') ? [HOUSE] : q.includes('Söderby') ? [SUBURB] : [];
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const url = `http://localhost:${(server.addr as Deno.NetAddr).port}/search`;
  const geocode = (args: string) => client.execJson<LocationResult>(`NOMINATIM_SEARCH_URL=${url} geocode-location ${args}`);

  try {
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);

    await t.step('locations a confident hit and records provenance', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/home`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/home -s address='Exempelgatan 27
999 77 Söderby'`);

      const result = await geocode(`${LOCATIONS_ROOT}/home`);
      assertEquals(result.status, 'applied');
      assertEquals(result.lat, 57.6612);
      // The multi-line legacy address reaches the geocoder as one line.
      assertEquals(queries.at(-1), 'Exempelgatan 27, 999 77 Söderby');

      const shape = await client.execJson<{ lat: number; lng: number; radius: number }>(`cat ${LOCATIONS_ROOT}/home/position`);
      assertEquals(shape.lat, 57.6612);
      assertEquals(shape.radius, 50);

      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/home`);
      assertEquals(attrs.geocodeStatus, 'applied');
      assertEquals(attrs.geocodePrecision, 'house');
      assertEquals(attrs.city, 'Göteborg');
      assertEquals(attrs.displayName, HOUSE.display_name);
      // The written address survives being geocoded.
      assertEquals(attrs.address, 'Exempelgatan 27\n999 77 Söderby');
      assertExists(attrs.geocodedAt);
    });

    await t.step('parks an uncertain hit as candidates, leaving no shape', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/vague`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/vague -s address='Söderby'`);

      const result = await geocode(`${LOCATIONS_ROOT}/vague`);
      assertEquals(result.status, 'review');
      assertEquals(result.candidates?.length, 1);

      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/vague`);
      assertEquals(attrs.geocodeStatus, 'review');
      assertEquals(attrs.geocodedAt, undefined);
      assertExists(attrs.geocodeAttemptedAt);

      const shape = await client.exec(`cat ${LOCATIONS_ROOT}/vague/position`);
      assertEquals(shape.data ?? '', '');
    });

    await t.step('migrates a legacy address parked in displayName', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/legacy`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/legacy -s displayName='Exempelgatan 27, 999 77'`);

      assertEquals((await geocode(`${LOCATIONS_ROOT}/legacy`)).status, 'applied');
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/legacy`);
      assertEquals(attrs.address, 'Exempelgatan 27, 999 77');
      // displayName is now the geocoder's, not the input.
      assertEquals(attrs.displayName, HOUSE.display_name);
    });

    await t.step('skips locations already placed or already attempted', async () => {
      assertEquals((await geocode(`${LOCATIONS_ROOT}/home`)).status, 'skipped');
      assertEquals((await geocode(`${LOCATIONS_ROOT}/vague`)).status, 'skipped');

      const before = queries.length;
      await geocode(`${LOCATIONS_ROOT}/vague`);
      assertEquals(queries.length, before, 'a skipped location must not call the geocoder');

      assertEquals((await geocode(`${LOCATIONS_ROOT}/vague --force`)).status, 'review');
    });

    await t.step('an edited address is looked up again', async () => {
      // Unplaced and already attempted: a new address is a new question.
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/vague -s address='Exempelgatan 27, 999 77'`);
      assertEquals((await geocode(`${LOCATIONS_ROOT}/vague`)).status, 'applied');
      assertEquals((await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/vague`)).geocodeInput, 'Exempelgatan 27, 999 77');
    });

    await t.step('a location whose edited address no longer resolves loses its shape', async () => {
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/vague -s address='Söderby'`);
      assertEquals((await geocode(`${LOCATIONS_ROOT}/vague`)).status, 'review');

      assertEquals((await client.exec(`cat ${LOCATIONS_ROOT}/vague/position`)).data ?? '', '');
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/vague`);
      assertEquals(attrs.locationSource, undefined);
      assertEquals(attrs.geocodedAt, undefined);
    });

    await t.step("coordinates set by hand are not the address's to move", async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/pinned`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/pinned/position --lat=58 --lng=12`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/pinned -s locationSource=manual -s address='Exempelgatan 27, 999 77'`);

      assertEquals((await geocode(`${LOCATIONS_ROOT}/pinned`)).status, 'skipped');
      assertEquals((await client.execJson<{ lat: number }>(`cat ${LOCATIONS_ROOT}/pinned/position`)).lat, 58);
    });

    await t.step('reports a location with no address at all', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/nameless`);
      const result = await geocode(`${LOCATIONS_ROOT}/nameless`);
      assertEquals(result.status, 'none');
      assertEquals(result.reason, 'no address to geocode');
    });

    await t.step('--dry-run reports the query without looking it up', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/dry`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/dry -s address='Exempelgatan 27, 999 77'`);

      const before = queries.length;
      const result = await geocode(`${LOCATIONS_ROOT}/dry --dry-run`);
      assertEquals(result.status, 'dry-run');
      assertEquals(result.query, 'Exempelgatan 27, 999 77');
      assertEquals(queries.length, before);
    });

    await t.step('--accept takes a parked suggestion and answers the review', async () => {
      // `vague` was parked for review above, with one suggestion.
      const result = await geocode(`${LOCATIONS_ROOT}/vague --accept 0 --radius 150`);
      assertEquals(result.status, 'applied');
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/vague`);
      assertEquals(attrs.geocodeStatus, 'applied');
      assertEquals(attrs.locationSource, 'nominatim');
      assertEquals(attrs.displayName, SUBURB.display_name);
      assertEquals(attrs.geocodeCandidates, undefined);
      assertExists(attrs.geocodedAt);
      const shape = await client.execJson<{ lat: number; lng: number; radius: number }>(`cat ${LOCATIONS_ROOT}/vague/position`);
      assertEquals([shape.lat, shape.lng, shape.radius], [57.65, 11.91, 150]);

      assertEquals((await client.exec(`JSON_OUTPUT=1 geocode-location ${LOCATIONS_ROOT}/vague --accept 3`)).success, false, 'no such suggestion');
    });

    await t.step('--drawn records a shape drawn by hand, keeping the geocoding timestamps', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/drawn`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/drawn -s address='Söderby'`);
      await geocode(`${LOCATIONS_ROOT}/drawn`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/drawn/position --lat=57.6 --lng=11.9 --radius=300`);

      assertEquals((await geocode(`${LOCATIONS_ROOT}/drawn --drawn`)).status, 'drawn');
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/drawn`);
      assertEquals(attrs.locationSource, 'manual');
      assertEquals(attrs.geocodeStatus, undefined);
      assertEquals(attrs.geocodeCandidates, undefined);
      assertExists(attrs.geocodeAttemptedAt);
    });
  } finally {
    await server.shutdown();
    client.close();
    await testCtx.teardown();
  }
});
