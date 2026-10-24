/** The Locations page gets its own compact list, without resolving archive media. */
import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Location = {
  id: string;
  name: string;
  address?: string;
  displayName?: string;
  locationSource?: string;
  locationPoints?: number;
  candidateCount: number;
  lat?: number;
  lng?: number;
};

Deno.test({ name: 'location-list', sanitizeResources: false, sanitizeOps: false }, async () => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/trip`);
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/park --as name=Park`);
    await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/park/position --lat=57.7 --lng=11.97`);
    await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/park -s locationSource=manual -J locationPoints=3`);

    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/review --as name=Review`);
    await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/review -s address=\'Somewhere\' -J geocodeCandidates=\'[{"lat":1},{"lat":2}]\'`);

    // A file's GPS fix shares the location registry, but is not a location and
    // must neither be returned nor trigger the map command's media work.
    await cmd.shouldSucceed(`mknode -t position ${ALBUMS_ROOT}/trip/position`);
    await cmd.shouldSucceed(`position-set ${ALBUMS_ROOT}/trip/position --lat=59.33 --lng=18.07`);

    const locations = await client.execJson<Location[]>('location-list');
    assertEquals(locations.map((location) => location.id), ['park', 'review']);
    assertEquals(locations[0]?.name, 'Park');
    assertEquals(locations[0]?.locationSource, 'manual');
    assertEquals(locations[0]?.locationPoints, 3);
    assertEquals(locations[0]?.lat, 57.7);
    assertEquals(locations[0]?.lng, 11.97);
    assertEquals(locations[1]?.address, 'Somewhere');
    assertEquals(locations[1]?.candidateCount, 2);

    const namesOnly = await client.execJson<Location[]>('location-list --without-coordinates');
    assertEquals(namesOnly.map((location) => location.lat), [undefined, undefined]);
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
