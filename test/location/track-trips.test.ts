/**
 * track-trips, trip-list and trip-edit on a device's track: trips are derived into the device's
 * `.trips`, a later run keeps what is settled and reads on from there, fixes added or rejected
 * before that point make it read the whole track, and edits join and part trips. The track is invented.
 */

import { DEVICES_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import type { DeviceTrips, TripList } from '@archive/location/api';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

const DEVICE = `${DEVICES_ROOT}/the-sailboat`;
const M2DEG = 1 / 111_320;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2025, 5, 1);

type Point = { lat: number; lng: number; ts: string };

const fix = (d: number, h: number, northM: number): Point => ({ lat: 59 + northM * M2DEG, lng: 18, ts: new Date(T0 + d * DAY + h * HOUR).toISOString() });
const rest = (d: number, days: number, northM: number): Point[] => Array.from({ length: days * 4 }, (_, i) => fix(d + Math.floor(i / 4), (i % 4) * 6, northM));
const out = (d: number, fromM: number, toM: number): Point[] => Array.from({ length: 4 }, (_, i) => fix(d, 9 + i, fromM + ((toM - fromM) * (i + 1)) / 4));

Deno.test({
  name: 'track-trips',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const append = (points: Point[]) => cmd.shouldSucceed(`track-append ${DEVICE} --json '${JSON.stringify(points)}'`);
  const list = () => client.execJson<TripList>(`trip-list the-sailboat`);

  try {
    await cmd.shouldSucceed(`mknode -p -t device ${DEVICE} --as name=the-sailboat --as kind=boat`);
    await cmd.shouldSucceed('track-create the-sailboat');

    await t.step('a device whose trips were never derived has none', async () => {
      assertEquals(await list(), { device: DEVICE, units: 'nautical', trips: [], stays: [] });
    });

    await t.step('trips are derived into .trips, and a dry run writes nothing', async () => {
      await append([...rest(0, 4, 0), ...out(4, 0, 10_000), ...rest(5, 4, 10_000)]);
      const dry = await client.execJson<DeviceTrips>('track-trips the-sailboat --dry-run');
      assertEquals(dry.trips.length, 1);
      assertEquals((await list()).trips, []);

      const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat');
      assertEquals(derived.trips.map((trip) => trip.id), ['2025-06-05']);
      assertEquals(derived.stays.map((stay) => stay.kind), ['rest', 'rest']);
      assertEquals(derived.settledUntil, derived.stays[1].start);
      const listed = await list();
      assertEquals(listed.trips, derived.trips);
      assertEquals(listed.lastFix, derived.lastFix);
    });

    await t.step('a later run keeps the settled trips and reads on from where they end', async () => {
      await append([...out(9, 10_000, 20_000), fix(9, 20, 20_000), fix(10, 4, 20_000), ...out(10, 20_000, 30_000)]);
      const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat');
      assertEquals(derived.trips.map((trip) => trip.id), ['2025-06-05', '2025-06-10']);
      assertEquals(derived.stays.map((stay) => stay.kind), ['rest', 'rest', 'overnight']);
      // The second trip leaves from the stay the first ended at.
      assertEquals(derived.trips[1].from.stay, derived.trips[0].to.stay);
      const full = await client.execJson<DeviceTrips>('track-trips the-sailboat --full --dry-run');
      assertEquals({ ...derived, computedAt: '' }, { ...full, computedAt: '' });
    });

    await t.step('fixes added before the settled point make the next run read the whole track', async () => {
      // A detour on the first trip, out to 15 km before it arrives.
      await append([fix(4, 10.5, 15_000)]);
      const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat');
      assert(derived.trips[0].maxDistanceM > 14_000, `first trip reaches ${derived.trips[0].maxDistanceM} m`);
    });

    await t.step('a fix that moves where the settled stay starts makes it read the whole track too', async () => {
      // Out to 16 km an hour after arriving: the stay starts only after it.
      await append([fix(4, 13, 16_000)]);
      const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat');
      assert(derived.trips[0].maxDistanceM > 15_000, `first trip reaches ${derived.trips[0].maxDistanceM} m`);
      assertEquals(derived.stays[1].start, fix(5, 0, 0).ts);
    });

    await t.step('a fix rejected by hand before the settled point makes it read the whole track too', async () => {
      // Out to 18 km on the first trip, and then that fix rejected: the settled stay still starts where it did.
      const far = fix(4, 11.5, 18_000);
      await append([far]);
      assert((await client.execJson<DeviceTrips>('track-trips the-sailboat')).trips[0].maxDistanceM > 17_000);

      await cmd.shouldSucceed(`track-mark the-sailboat --from ${far.ts} --to ${new Date(Date.parse(far.ts) + 1).toISOString()} --reject`);
      const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat');
      assert(derived.trips[0].maxDistanceM < 17_000, `first trip reaches ${derived.trips[0].maxDistanceM} m`);
      assertEquals(derived.stays[1].start, fix(5, 0, 0).ts);
    });

    await t.step('trip-edit joins a trip to the one before it, and parts it again', async () => {
      await cmd.shouldSucceed('trip-edit the-sailboat 2025-06-10 --merge');
      let listed = await list();
      assertEquals(listed.trips.map((trip) => trip.id), ['2025-06-05']);
      assertEquals(listed.trips[0].joined?.length, 1);
      const edits = (await client.execJson<{ tripEdits?: { merge?: string[] } }>(`attrs ${DEVICE}`)).tripEdits;
      assertEquals(edits?.merge?.length, 1);

      await cmd.shouldSucceed('trip-edit the-sailboat 2025-06-10 --split');
      listed = await list();
      assertEquals(listed.trips.map((trip) => trip.id), ['2025-06-05', '2025-06-10']);
      assertEquals((await client.execJson<{ tripEdits?: unknown }>(`attrs ${DEVICE}`)).tripEdits, undefined);
    });

    await t.step('trip-edit starts a trip at a midnight, and joins it again', async () => {
      await cmd.shouldSucceed('trip-edit the-sailboat 2025-06-11 --split');
      assertEquals((await list()).trips.map((trip) => trip.id), ['2025-06-05', '2025-06-10', '2025-06-11']);
      await cmd.shouldSucceed('trip-edit the-sailboat 2025-06-11 --merge');
      assertEquals((await list()).trips.map((trip) => trip.id), ['2025-06-05', '2025-06-10']);
    });

    await t.step('trip-edit refuses what it cannot do', async () => {
      await cmd.shouldFailWith('trip-edit the-sailboat 2025-06-05 --merge', 'first trip');
      await cmd.shouldFailWith('trip-edit the-sailboat 2025-07-01 --merge', 'no trip');
      await cmd.shouldFailWith('trip-edit the-sailboat 2025-06-05 --split', 'no trip goes on');
      await cmd.shouldFailWith('trip-edit the-sailboat 2025-06-10', 'usage');
    });
  } finally {
    await testCtx.teardown();
  }
});
