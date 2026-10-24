/**
 * location-region — a location name to the box `search --bbox=` takes, against a stub Nominatim.
 *
 * The stub answers from the query string, so the suite never touches the network. What is
 * checked is what search needs: the box in north,south,east,west order, the bare form for
 * `$(…)`, and a loud failure — not an empty box — when nothing is found.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

// Nominatim's boundingbox is [south, north, west, east], as strings.
const EXEMPELSTAD = {
  lat: '57.7',
  lon: '11.97',
  display_name: 'Exempelstad, Exempellän, Sverige',
  boundingbox: ['57.60', '57.80', '11.80', '12.10'],
  addresstype: 'city',
};
// A location west of Greenwich and south of the equator: every number in its box is negative.
const SÖDERORT = {
  lat: '-34.0',
  lon: '-58.4',
  display_name: 'Söderort, Exempelland',
  boundingbox: ['-34.70', '-34.50', '-58.60', '-58.30'],
  addresstype: 'city',
};

Deno.test({
  name: 'location-region',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    const hits = q === 'Exempelstad' ? [EXEMPELSTAD] : q === 'Söderort' ? [SÖDERORT] : [];
    return Response.json(hits);
  });
  const url = `http://localhost:${(server.addr as Deno.NetAddr).port}/search`;

  try {
    await t.step('answers with the box in the order search --bbox reads', async () => {
      const result = await client.execJson<{ name: string; display: string; bbox: string; north: number; west: number }>(
        `NOMINATIM_SEARCH_URL=${url} location-region Exempelstad`,
      );
      assertEquals(result.bbox, '57.8,57.6,12.1,11.8');
      assertEquals(result.display, 'Exempelstad, Exempellän, Sverige');
    });

    await t.step('--bbox-only is the bare box, for $(…)', async () => {
      const result = await cmd.shouldSucceed(`JSON_OUTPUT=0 NOMINATIM_SEARCH_URL=${url} location-region Söderort --bbox-only`);
      assertEquals(String(result.data), '-34.5,-34.7,-58.3,-58.6');
    });

    await t.step('a name nobody knows fails rather than answering with no box', async () => {
      const failed = await cmd.shouldFail(`NOMINATIM_SEARCH_URL=${url} location-region Ingenstans`);
      assertStringIncludes(failed.error ?? '', 'no location called');
    });
  } finally {
    await server.shutdown();
    await testCtx.teardown();
  }
});
