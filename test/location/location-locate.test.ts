/**
 * location-locate end to end: the media centroid wins when the linked files say
 * where a location is, and the address geocoder only gets asked when they don't.
 *
 * The stub geocoder on loopback doubles as the assertion that the fallback is
 * *not* reached — a location placed from its media must cost no request at all.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assert, assertAlmostEquals, assertEquals, assertExists } from '@std/assert';
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

/** A house whose postcode confirms the written address, found street-line only. */
const STREET_ONLY_HOUSE = {
  lat: '57.6606',
  lon: '11.9317',
  display_name: '18, Provgatan, Norrhamn, Göteborg, 999 39, Sverige',
  category: 'place',
  type: 'house',
  addresstype: 'place',
  importance: 0.2,
  address: { house_number: '18', road: 'Provgatan', city: 'Göteborg', postcode: '999 39', country: 'Sverige' },
};

type LocationResult = {
  path: string;
  status: string;
  source?: string;
  reason?: string;
  lat?: number;
  lng?: number;
  radius?: number;
  used?: number;
  dropped?: number;
  spread?: number;
};

type AllResult = { counts: Record<string, number>; results: LocationResult[] };

Deno.test({
  name: 'location-locate',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const queries: string[] = [];
  /** Each lookup's `countrycodes`, so the restriction rule is checkable. */
  const countries: string[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const params = new URL(req.url).searchParams;
    const q = params.get('q') ?? '';
    queries.push(q);
    countries.push(params.get('countrycodes') ?? '');
    // Only the street line finds Provgatan — the district blocks the full
    // address, exactly as the real geocoder behaves.
    const body = q.includes('Exempelgatan 27') ? [HOUSE] : q === 'Provgatan 18' ? [STREET_ONLY_HOUSE] : [];
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const url = `http://localhost:${(server.addr as Deno.NetAddr).port}/search`;
  const locate = (args: string) => client.execJson<LocationResult>(`NOMINATIM_SEARCH_URL=${url} location-locate ${args}`);

  /** A media file with its own GPS fix, optionally linked to a location. */
  const media = async (path: string, lat: number, lng: number, location?: string) => {
    await cmd.shouldSucceed(`mknode -p -t directory ${path}`);
    await cmd.shouldSucceed(`mknode -t position ${path}/position`);
    await cmd.shouldSucceed(`position-set ${path}/position --lat=${lat} --lng=${lng}`);
    if (location) await cmd.shouldSucceed(`ln -s ${location} ${path}/location`);
  };

  try {
    await cmd.shouldSucceed(`mknode -p -t directory ${LOCATIONS_ROOT}`);
    await cmd.shouldSucceed(`mknode -p -t directory ${ALBUMS_ROOT}/trip/files`);

    await t.step('locations a park from the media linked to it, without geocoding', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/park`);
      // Five fixes across a park-sized area.
      await media(`${ALBUMS_ROOT}/trip/files/p1`, 57.6952, 11.9915, `${LOCATIONS_ROOT}/park`);
      await media(`${ALBUMS_ROOT}/trip/files/p2`, 57.6961, 11.9948, `${LOCATIONS_ROOT}/park`);
      await media(`${ALBUMS_ROOT}/trip/files/p3`, 57.6944, 11.9932, `${LOCATIONS_ROOT}/park`);
      await media(`${ALBUMS_ROOT}/trip/files/p4`, 57.6958, 11.9901, `${LOCATIONS_ROOT}/park`);
      await media(`${ALBUMS_ROOT}/trip/files/p5`, 57.6949, 11.9960, `${LOCATIONS_ROOT}/park`);

      const before = queries.length;
      const result = await locate(`${LOCATIONS_ROOT}/park`);

      assertEquals(result.status, 'applied');
      assertEquals(result.source, 'media-centroid');
      assertEquals(result.used, 5);
      assertAlmostEquals(result.lat!, 57.6953, 0.001);
      assertAlmostEquals(result.lng!, 11.9931, 0.001);
      // The centroid is local: the geocoder was never asked.
      assertEquals(queries.length, before);

      const shape = await client.execJson<{ lat: number; lng: number; radius: number }>(`cat ${LOCATIONS_ROOT}/park/position`);
      assertAlmostEquals(shape.lat, 57.6953, 0.001);
      // The radius describes the park, rather than a default.
      assert(shape.radius > 25 && shape.radius < 500, `radius ${shape.radius} is not park-sized`);

      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/park`);
      assertEquals(attrs.locationSource, 'media-centroid');
      assertEquals(attrs.locationPoints, 5);
      assertExists(attrs.geocodedAt);
    });

    await t.step('a mislinked photo is dropped instead of moving the location', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/bar`);
      await media(`${ALBUMS_ROOT}/trip/files/b1`, 57.7000, 11.9700, `${LOCATIONS_ROOT}/bar`);
      await media(`${ALBUMS_ROOT}/trip/files/b2`, 57.7001, 11.9701, `${LOCATIONS_ROOT}/bar`);
      await media(`${ALBUMS_ROOT}/trip/files/b3`, 57.7000, 11.9702, `${LOCATIONS_ROOT}/bar`);
      // Somebody linked a holiday photo to the local bar.
      await media(`${ALBUMS_ROOT}/trip/files/b4`, 41.9028, 12.4964, `${LOCATIONS_ROOT}/bar`);

      const result = await locate(`${LOCATIONS_ROOT}/bar`);
      assertEquals(result.status, 'applied');
      assertEquals(result.used, 3);
      assertEquals(result.dropped, 1);
      assertAlmostEquals(result.lat!, 57.7000, 0.001);
      assertAlmostEquals(result.lng!, 11.9701, 0.001);
    });

    await t.step('falls back to the address when there is no media', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/home`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/home -s address='Exempelgatan 27
999 77 Söderby'`);

      const result = await locate(`${LOCATIONS_ROOT}/home`);
      assertEquals(result.status, 'applied');
      assertEquals(result.source, 'nominatim');
      assertEquals(result.lat, 57.6612);
      assertEquals(queries.at(-1), 'Exempelgatan 27, 999 77 Söderby');
      // The report says why the preferred source did not answer.
      assert(result.reason?.includes('no centroid'), `reason does not explain the fallback: ${result.reason}`);
    });

    await t.step('one photo is too thin a basis, and falls through', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/lone`);
      await media(`${ALBUMS_ROOT}/trip/files/l1`, 12.3456, 65.4321, `${LOCATIONS_ROOT}/lone`);

      // No address either, so nothing is written and the reason survives.
      const result = await locate(`${LOCATIONS_ROOT}/lone`);
      assertEquals(result.status, 'none');
      assert(result.reason?.includes('needs 2'), `reason lost the centroid verdict: ${result.reason}`);
      await cmd.shouldSucceed(`test -z "$(cat ${LOCATIONS_ROOT}/lone/position)"`);

      // ...until the caller says one point is enough.
      const relaxed = await locate(`${LOCATIONS_ROOT}/lone --min-points 1`);
      assertEquals(relaxed.status, 'applied');
      assertEquals(relaxed.source, 'media-centroid');
      assertAlmostEquals(relaxed.lat!, 12.3456, 0.0001);
    });

    await t.step('a location name is looked up worldwide, an address Sweden-first', async () => {
      // A bare name is as likely to be abroad as not, so restricting it to one
      // country would answer confidently and wrongly.
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/amsterdam`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/amsterdam -s name='Amsterdam'`);
      countries.length = 0;
      await locate(`${LOCATIONS_ROOT}/amsterdam`);
      assertEquals(countries, ['']);

      // An unqualified Swedish address needs the restriction to win — but when
      // it finds nothing, the address may simply not be Swedish, so the second
      // attempt drops it rather than writing the location off. A third and last
      // attempt retries the street line alone, which is what rescues an address
      // whose district Nominatim cannot match.
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/abroad`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/abroad -s address='400 Example Drive, Testville IL 60000, USA'`);
      countries.length = 0;
      queries.length = 0;
      await locate(`${LOCATIONS_ROOT}/abroad`);
      assertEquals(countries, ['se', '', 'se']);
      assertEquals(queries, [
        '400 Example Drive, Testville IL 60000, USA',
        '400 Example Drive, Testville IL 60000, USA',
        '400 Example Drive',
      ]);

      // A hit first time round costs only the one restricted lookup.
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/swede`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/swede -s address='Exempelgatan 27, 999 77 Söderby'`);
      countries.length = 0;
      assertEquals((await locate(`${LOCATIONS_ROOT}/swede`)).status, 'applied');
      assertEquals(countries, ['se']);
    });

    await t.step('a street whose district Nominatim cannot match still resolves', async () => {
      // The real shape of the legacy corpus: the street and postcode are right,
      // but "Söderby" is a postal name OSM does not file the street
      // under, and free-text search answers nothing rather than something
      // weaker. Only the street line finds it.
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/flojtgatan`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/flojtgatan -s address='Provgatan 18, 999 39 Söderby'`);

      queries.length = 0;
      const result = await locate(`${LOCATIONS_ROOT}/flojtgatan`);

      assertEquals(result.status, 'applied');
      // Sweden-first, then worldwide in case it is not a Swedish address, and
      // only then the street on its own.
      assertEquals(queries, [
        'Provgatan 18, 999 39 Söderby',
        'Provgatan 18, 999 39 Söderby',
        'Provgatan 18',
      ]);
      assertEquals(result.lat, 57.6606);

      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/flojtgatan`);
      // The provenance says the answer rests on the postcode, not on the
      // address as written.
      assertEquals(attrs.geocodeRelaxed, true);
      assertEquals(attrs.geocodeQuery, 'Provgatan 18');
      // The address as written survives, so the location can be corrected later.
      assertEquals(attrs.address, 'Provgatan 18, 999 39 Söderby');
    });

    await t.step('--no-geocode keeps a location without media unplaced', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/nowhere`);
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/nowhere -s address='Exempelgatan 27, 999 77'`);

      const before = queries.length;
      const result = await locate(`${LOCATIONS_ROOT}/nowhere --no-geocode`);
      assertEquals(result.status, 'empty');
      assertEquals(queries.length, before);
    });

    await t.step('a placed location is skipped, and --force re-derives it', async () => {
      const skipped = await locate(`${LOCATIONS_ROOT}/park`);
      assertEquals(skipped.status, 'skipped');
      assertEquals(skipped.reason, 'already placed');

      const forced = await locate(`${LOCATIONS_ROOT}/park --force`);
      assertEquals(forced.status, 'applied');
      assertEquals(forced.used, 5);
    });

    await t.step('--dry-run reports the centroid without writing it', async () => {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/dry`);
      await media(`${ALBUMS_ROOT}/trip/files/d1`, 59.3293, 18.0686, `${LOCATIONS_ROOT}/dry`);
      await media(`${ALBUMS_ROOT}/trip/files/d2`, 59.3300, 18.0700, `${LOCATIONS_ROOT}/dry`);

      const result = await locate(`${LOCATIONS_ROOT}/dry --dry-run`);
      assertEquals(result.status, 'dry-run');
      assertEquals(result.source, 'media-centroid');
      assertEquals(result.used, 2);
      await cmd.shouldSucceed(`test -z "$(cat ${LOCATIONS_ROOT}/dry/position)"`);
    });

    await t.step(`--all walks ${LOCATIONS_ROOT} and summarizes`, async () => {
      const result = await client.execJson<AllResult>(
        `NOMINATIM_SEARCH_URL=${url} location-locate --all --no-geocode`,
      );
      // park/bar/home/lone/swede/flojtgatan are placed by now; the rest are not.
      assertEquals(result.counts.skipped, 6);
      assertEquals(result.counts.applied, 1); // /locations/dry, from its two points
      // nowhere, amsterdam and abroad have no media and no geocoder to fall back on.
      assertEquals(result.counts.empty, 3);
      assertEquals(result.results.length, 10);
    });

    await t.step('--refresh writes nothing when the photos have not moved the location', async () => {
      const result = await locate(`${LOCATIONS_ROOT}/park --refresh`);
      assertEquals(result.status, 'skipped');
      assertEquals(result.reason, 'photos have not moved it');
    });

    await t.step('--refresh ignores photos linked only because they are inside the shape', async () => {
      // A cluster the shape itself pulled in: counting it would let the circle define itself.
      for (const [i, lat] of [57.6975, 57.6976, 57.6977].entries()) {
        await media(`${ALBUMS_ROOT}/trip/files/s${i}`, lat, 11.9990, `${LOCATIONS_ROOT}/park`);
        await cmd.shouldSucceed(`attrs -L ${ALBUMS_ROOT}/trip/files/s${i}/location -s linkSource=shape`);
      }
      const result = await locate(`${LOCATIONS_ROOT}/park --refresh`);
      assertEquals(result.status, 'skipped');
      assertEquals(result.reason, 'photos have not moved it');
    });

    await t.step('--refresh follows a newly linked photo', async () => {
      await media(`${ALBUMS_ROOT}/trip/files/p6`, 57.6956, 11.9925, `${LOCATIONS_ROOT}/park`);
      const result = await locate(`${LOCATIONS_ROOT}/park --refresh`);
      assertEquals(result.status, 'applied');
      assertEquals(result.used, 6);
    });

    await t.step('--refresh never moves coordinates set by hand', async () => {
      await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/park -s locationSource=manual`);
      const result = await locate(`${LOCATIONS_ROOT}/park --refresh`);
      assertEquals(result.status, 'skipped');
      assertEquals(result.reason, 'set by hand');
    });
  } finally {
    await server.shutdown();
    await testCtx.teardown();
  }
});
