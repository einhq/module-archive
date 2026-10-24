/**
 * geocode-position against a stub reverse geocoder on loopback: the address lands on the position
 * node, with the named place the point is at (`poi`) and its neighbourhood (`suburb`); a node
 * geocoded already, or with no point yet, is skipped.
 */
import { assertEquals } from '@std/assert';
import type { GeocodePositionResult } from '@archive/location/api';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

/** Answers by latitude, so one server covers every case. */
const ANSWERS: Record<string, unknown> = {
  // A point at a named place: its name is neither the road nor the town.
  '57.1': {
    name: 'Exempelmuseet',
    display_name: 'Exempelmuseet, Exempelgatan 3, Exempelby, Exempelstad, Sverige',
    address: { road: 'Exempelgatan', house_number: '3', suburb: 'Exempelby', city: 'Exempelstad', country: 'Sverige' },
  },
  // A point on a street: the name is the street's again, and the neighbourhood has no suburb.
  '57.2': {
    name: 'Exempelgatan',
    display_name: 'Exempelgatan, Exempelvik, Exempelstad, Sverige',
    address: { road: 'Exempelgatan', neighbourhood: 'Exempelvik', city: 'Exempelstad', country: 'Sverige' },
  },
};

Deno.test({ name: 'geocode-position', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const lat = new URL(req.url).searchParams.get('lat') ?? '';
    return new Response(JSON.stringify(ANSWERS[lat] ?? {}), { headers: { 'content-type': 'application/json' } });
  });
  const url = `http://localhost:${(server.addr as Deno.NetAddr).port}/reverse`;
  const geocode = (path: string) => client.execJson<GeocodePositionResult>(`NOMINATIM_REVERSE_URL=${url} geocode-position ${path}`);
  const place = async (name: string, lat: number) => {
    await cmd.shouldSucceed(`mkdir -p /geo && mknode -t file /geo/${name}.jpg && mknode -t position /geo/${name}.jpg/position`);
    await cmd.shouldSucceed(`position-set /geo/${name}.jpg/position --lat=${lat} --lng=12.5`);
    return `/geo/${name}.jpg/position`;
  };

  try {
    await t.step('a named place is kept as poi, and the suburb beside the city', async () => {
      const position = await place('museum', 57.1);
      const result = await geocode(position);
      assertEquals('poi' in result && result.poi, 'Exempelmuseet');
      const attrs = await client.execJson<Record<string, string>>(`attrs ${position}`);
      assertEquals([attrs.poi, attrs.suburb, attrs.city, attrs.road], ['Exempelmuseet', 'Exempelby', 'Exempelstad', 'Exempelgatan']);
    });

    await t.step("a street's own name is no poi; a neighbourhood stands in for a missing suburb", async () => {
      const position = await place('street', 57.2);
      await geocode(position);
      const attrs = await client.execJson<Record<string, string>>(`attrs ${position}`);
      assertEquals([attrs.poi, attrs.suburb], [undefined, 'Exempelvik']);
    });

    await t.step('a position geocoded already is skipped, and says when it was', async () => {
      const position = '/geo/museum.jpg/position';
      const { geocodedAt } = await client.execJson<{ geocodedAt: string }>(`attrs ${position}`);
      assertEquals(await geocode(position), { skipped: 'geocoded already', geocodedAt });
    });

    await t.step('a position with no point yet is skipped', async () => {
      await cmd.shouldSucceed('mknode -t file /geo/blank.jpg && mknode -t position /geo/blank.jpg/position');
      assertEquals(await geocode('/geo/blank.jpg/position'), { skipped: 'no position data' });
    });
  } finally {
    await server.shutdown();
    client.close();
    await testCtx.teardown();
  }
});
