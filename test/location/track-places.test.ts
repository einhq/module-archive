/**
 * track-places on a device's stays, against stub Overpass and Nominatim servers on loopback: a
 * stay near a location is at it, past the photos nearer to it, one near a named harbour gets a
 * location named after it, one with none gets the town; a failed lookup is asked again on the next
 * run, a place with no name is not,
 * a placed stay is never looked up again, the album of a trip gets the locations of its stays, and
 * `--rename` leaves a name given by hand alone. What the services answered is kept: Overpass is
 * asked once per tile, and another device at the same places asks nobody. The track and the
 * places are invented.
 */

import { ALBUMS_ROOT, DEVICES_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import type { DeviceTrips, TrackPlaces, TripList } from '@archive/location/api';
import type { AlbumTrip } from '@archive/media/api';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

const DEVICE = `${DEVICES_ROOT}/the-sailboat`;
const DINGHY = `${DEVICES_ROOT}/the-dinghy`;
/** Where the first stay is; away from a tile's edge, so the stays 10 km apart are in tiles of their own. */
const BASE_LAT = 59.02;
const M2DEG = 1 / 111_320;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2025, 5, 1);

type Point = { lat: number; lng: number; ts: string };

const fix = (d: number, h: number, northM: number): Point => ({ lat: BASE_LAT + northM * M2DEG, lng: 18, ts: new Date(T0 + d * DAY + h * HOUR).toISOString() });
const rest = (d: number, days: number, northM: number): Point[] => Array.from({ length: days * 4 }, (_, i) => fix(d + Math.floor(i / 4), (i % 4) * 6, northM));
const out = (d: number, fromM: number, toM: number): Point[] => Array.from({ length: 4 }, (_, i) => fix(d, 9 + i, fromM + ((toM - fromM) * (i + 1)) / 4));

/** How far north of the first stay a point is, to the kilometre. */
const kmNorth = (lat: number): number => Math.round((lat - BASE_LAT) / M2DEG / 1000);

Deno.test({
  name: 'track-places',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  // The named features the Overpass stub knows, by the first stay; the Nominatim stub answers by
  // how far north a point is.
  let harbourAt0 = 'Exempelhamnen';
  let overpassDown = false;
  let townAt20 = 'Exempelby';
  const features = () => [
    { type: 'node', lat: BASE_LAT, lon: 18, tags: { leisure: 'marina', name: 'Gästhamn' } },
    { type: 'way', center: { lat: BASE_LAT + 200 * M2DEG, lon: 18 }, tags: { leisure: 'marina', name: harbourAt0, operator: 'Exempelklubben' } },
    { type: 'way', center: { lat: BASE_LAT + 50 * M2DEG, lon: 18 }, tags: { place: 'island', name: 'Exempelön' } },
  ];
  /** The requests the stubs had: `overpass <south edge of the box>`, `nominatim <km north>`. */
  const asked: string[] = [];
  const overpass = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const query = new URLSearchParams(await req.text()).get('data') ?? '';
    const [south, west, north, east] = (query.match(/nwr\(([-\d.,]+)\)/)?.[1] ?? '').split(',').map(Number);
    asked.push(`overpass ${south.toFixed(2)}`);
    if (overpassDown) return new Response('busy', { status: 504 });
    const inside = (at: { lat: number; lon: number }) => at.lat >= south && at.lat <= north && at.lon >= west && at.lon <= east;
    return Response.json({ elements: features().filter((element) => inside(element.center ?? { lat: element.lat!, lon: element.lon! })) });
  });
  const nominatim = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const km = kmNorth(Number(new URL(req.url).searchParams.get('lat')));
    asked.push(`nominatim ${km}`);
    const village = km === 20 ? townAt20 : km === 10 ? 'Mellanby' : undefined;
    return Response.json(village ? { address: { village, county: 'Exempellän' } } : { error: 'Unable to geocode' });
  });
  const env = `OVERPASS_URL=http://localhost:${(overpass.addr as Deno.NetAddr).port}/api/interpreter ` +
    `NOMINATIM_REVERSE_URL=http://localhost:${(nominatim.addr as Deno.NetAddr).port}/reverse`;
  const places = (args = '') => client.execJson<TrackPlaces>(`${env} track-places the-sailboat ${args}`);
  const list = () => client.execJson<TripList>('trip-list the-sailboat');
  const append = (points: Point[]) => cmd.shouldSucceed(`track-append ${DEVICE} --json '${JSON.stringify(points)}'`);

  try {
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
    await cmd.shouldSucceed(`mknode -p -t device ${DEVICE} --as name=the-sailboat --as kind=boat`);
    await cmd.shouldSucceed('track-create the-sailboat');
    // A jetty 80 m from where the second stay is.
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/the-jetty --as name='The jetty'`);
    await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/the-jetty/position --lat=${BASE_LAT + 10_080 * M2DEG} --lng=18`);
    // Photos where the second stay is, nearer to it than the jetty: the jetty is found past them.
    await cmd.shouldSucceed('mkdir -p /photos');
    for (let n = 1; n <= 6; n++) {
      await cmd.shouldSucceed(`mknode -t file /photos/p${n}.jpg`);
      await cmd.shouldSucceed(`position-set /photos/p${n}.jpg/position --lat=${BASE_LAT + 10_000 * M2DEG} --lng=18`);
    }
    await append([...rest(0, 4, 0), ...out(4, 0, 10_000), ...rest(5, 4, 10_000), ...out(9, 10_000, 20_000), ...rest(10, 4, 20_000)]);
    await cmd.shouldSucceed('track-trips the-sailboat');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed('trip-album the-sailboat 2025-06-05 --new --name Out');

    await t.step('a dry run looks the places up and makes nothing', async () => {
      const dry = await places('--dry-run');
      assertEquals(dry.stays.map((stay) => stay.outcome), ['created', 'near', 'created']);
      assertEquals((await client.execJson<{ id: string }[]>('location-list')).map((location) => location.id), ['the-jetty']);
      assertEquals((await list()).stays.map((stay) => stay.location), [undefined, undefined, undefined]);
    });

    await t.step('each stay is at the location near it, or at one named after the harbour or the town there', async () => {
      asked.length = 0;
      const placed = await places();
      assertEquals(placed.failed, 0);
      assertEquals(placed.stays.map((stay) => [stay.outcome, stay.name]), [
        ['created', 'Exempelhamnen'],
        ['near', 'The jetty'],
        ['created', 'Exempelby'],
      ]);
      // The jetty is matched without asking anyone; the dry run kept nothing.
      assertEquals(asked, ['overpass 59.00', 'overpass 59.15', 'nominatim 20']);
      assertEquals(placed.requests, 3);
      // Only the tags a name is chosen by are kept.
      const tile = await client.execJson<{ elements: { tags: Record<string, string> }[] }>('cat /archive/sources/places/59.00_18.0.json');
      assertEquals(tile.elements.map((element) => 'operator' in element.tags), [false, false, false]);

      const harbour = `${LOCATIONS_ROOT}/exempelhamnen`;
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${harbour}`);
      assertEquals([attrs.name, attrs.locationSource, attrs.placeKind, attrs.nameSource], ['Exempelhamnen', 'track', 'marina', 'overpass']);
      const town = await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/exempelby`);
      assertEquals([town.placeKind, town.nameSource], ['town', 'nominatim']);
      const shape = await client.execJson<{ lat: number; lng: number; radius: number }>(`cat ${harbour}/position`);
      assertEquals(shape.radius, 150);

      const listed = await list();
      assertEquals(listed.stays.map((stay) => [stay.location, stay.name]), [
        [harbour, 'Exempelhamnen'],
        [`${LOCATIONS_ROOT}/the-jetty`, 'The jetty'],
        [`${LOCATIONS_ROOT}/exempelby`, 'Exempelby'],
      ]);
    });

    await t.step('the album of a trip gets the locations its stays were put at', async () => {
      const trip = (await client.execJson<{ trip?: AlbumTrip }>(`attrs ${ALBUMS_ROOT}/Out`)).trip;
      assertEquals(trip?.stays.map((stay) => stay.location), [`${LOCATIONS_ROOT}/exempelhamnen`, `${LOCATIONS_ROOT}/the-jetty`]);
    });

    await t.step('a placed stay is not looked up again, and deriving the trips again keeps its place', async () => {
      asked.length = 0;
      assertEquals((await places()).stays, []);
      const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat --full');
      assertEquals(derived.stays.map((stay) => stay.location?.slice(LOCATIONS_ROOT.length + 1)), ['exempelhamnen', 'the-jetty', 'exempelby']);
      assertEquals((await places()).stays, []);
      assertEquals(asked, []);
    });

    await t.step('a failed lookup leaves the stay for the next run, which asks again', async () => {
      // Back to the harbour: within 150 m of it, so it is at it; then on to 30 km, where nothing has a name.
      await append([...out(14, 20_000, 100), ...rest(15, 4, 100), ...out(19, 100, 30_000), ...rest(20, 4, 30_000)]);
      await cmd.shouldSucceed('track-trips the-sailboat');
      overpassDown = true;
      const failed = await places();
      assertEquals(failed.stays.map((stay) => stay.outcome), ['near', 'failed']);
      assertEquals(failed.failed, 1);
      assertEquals((await list()).stays.map((stay) => stay.location !== undefined), [true, true, true, true, false]);

      overpassDown = false;
      asked.length = 0;
      const again = await places();
      assertEquals(again.stays.map((stay) => [stay.stay, stay.outcome]), [[4, 'unnamed']]);
      assertEquals(asked, ['overpass 59.25', 'nominatim 30']);
      assertEquals((await list()).stays[4].unnamed, true);
      assertEquals((await places()).stays, []);
    });

    await t.step('another device at the same places asks nobody', async () => {
      // 200 m from where the sailboat found no name, and 300 m from its town: no location within
      // 150 m of either, but the answers there are kept.
      await cmd.shouldSucceed(`mknode -p -t device ${DINGHY} --as name=the-dinghy --as kind=boat`);
      await cmd.shouldSucceed('track-create the-dinghy');
      await cmd.shouldSucceed(`track-append ${DINGHY} --json '${JSON.stringify([...rest(30, 4, 30_200), ...out(34, 30_200, 19_700), ...rest(35, 4, 19_700)])}'`);
      await cmd.shouldSucceed('track-trips the-dinghy');
      asked.length = 0;
      const placed = await client.execJson<TrackPlaces>(`${env} track-places the-dinghy`);
      assertEquals(placed.stays.map((stay) => [stay.outcome, stay.name]), [['unnamed', undefined], ['created', 'Exempelby']]);
      assertEquals(asked, []);
      assertEquals(placed.requests, 0);
    });

    await t.step('--rename takes a new name, except one given by hand', async () => {
      await cmd.shouldSucceed(`location-update ${LOCATIONS_ROOT}/exempelby --name 'Our cove'`);
      assertEquals((await client.execJson<Record<string, unknown>>(`attrs ${LOCATIONS_ROOT}/exempelby`)).nameSource, undefined);
      harbourAt0 = 'Nyhamnen';
      townAt20 = 'Annanby';
      asked.length = 0;
      const renamed = await places('--rename');
      // Only the harbour's name came from a service and was not changed by hand.
      assertEquals(asked, ['overpass 59.00']);
      assertEquals(renamed.renamed, [{ location: `${LOCATIONS_ROOT}/exempelhamnen`, from: 'Exempelhamnen', to: 'Nyhamnen' }]);
      const names = (await list()).stays.map((stay) => stay.name);
      assertEquals(names, ['Nyhamnen', 'The jetty', 'Our cove', 'Nyhamnen', undefined]);
    });

    await t.step('a stay whose location is gone is placed again', async () => {
      await cmd.shouldSucceed(`rm -r ${LOCATIONS_ROOT}/the-jetty`);
      const placed = await places();
      assertEquals(placed.stays.map((stay) => [stay.stay, stay.outcome, stay.name]), [[1, 'created', 'Mellanby']]);
      assertEquals((await list()).stays[1].location, `${LOCATIONS_ROOT}/mellanby`);
    });

    await t.step('a location made for a stay is made again from the kept answers once it is gone', async () => {
      await cmd.shouldSucceed(`rm -r ${LOCATIONS_ROOT}/exempelhamnen`);
      asked.length = 0;
      const placed = await places();
      assertEquals(placed.stays.map((stay) => [stay.stay, stay.outcome, stay.name]), [[0, 'created', 'Nyhamnen'], [3, 'near', 'Nyhamnen']]);
      assertEquals(asked, []);
    });
  } finally {
    await overpass.shutdown();
    await nominatim.shutdown();
    await testCtx.teardown();
  }
});
