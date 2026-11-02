/**
 * trip-album: a trip of a device's track becomes a new album or one that is there, which then holds
 * it as its attr `trip`, lists the device and spans the trip without any photos; a trip is one
 * album's and an album holds one trip; `--detach` takes it off again; and an ongoing trip's album
 * grows with it as `track-trips` runs. The tracks are invented.
 */

import { ALBUMS_ROOT, DEVICES_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import type { DeviceTrips, TripList } from '@archive/location/api';
import type { AlbumDeviceList, AlbumTrip, TripAlbumAnswer } from '@archive/media/api';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

const BOAT = `${DEVICES_ROOT}/the-sailboat`;
const CAR = `${DEVICES_ROOT}/the-car`;
const M2DEG = 1 / 111_320;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2025, 5, 1);

type Point = { lat: number; lng: number; ts: string };
type AlbumAttrs = { name?: string; trip?: AlbumTrip; timeStart?: string; timeEnd?: string };

const fixAt = (ms: number, northM: number): Point => ({ lat: 59 + northM * M2DEG, lng: 18, ts: new Date(ms).toISOString() });
const fix = (d: number, h: number, northM: number): Point => fixAt(T0 + d * DAY + h * HOUR, northM);
const rest = (d: number, days: number, northM: number): Point[] => Array.from({ length: days * 4 }, (_, i) => fix(d + Math.floor(i / 4), (i % 4) * 6, northM));
const out = (d: number, fromM: number, toM: number): Point[] => Array.from({ length: 4 }, (_, i) => fix(d, 9 + i, fromM + ((toM - fromM) * (i + 1)) / 4));

Deno.test({
  name: 'trip-album',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const attrs = (path: string) => client.execJson<AlbumAttrs>(`attrs '${path}'`);
  const list = (device = 'the-sailboat') => client.execJson<TripList>(`trip-list ${device}`);

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed(`mknode -p -t device ${BOAT} --as name=Sailboat --as kind=boat --as timezone=Europe/Stockholm`);
    await cmd.shouldSucceed('track-create the-sailboat');
    // Two trips: one day out on 2025-06-05, and two days from 2025-06-10 with a night at anchor.
    const points = [
      ...rest(0, 4, 0),
      ...out(4, 0, 10_000),
      ...rest(5, 4, 10_000),
      ...out(9, 10_000, 20_000),
      fix(9, 20, 20_000),
      fix(10, 4, 20_000),
      ...out(10, 20_000, 30_000),
      ...rest(11, 4, 30_000),
    ];
    await cmd.shouldSucceed(`track-append ${BOAT} --json '${JSON.stringify(points)}'`);
    const derived = await client.execJson<DeviceTrips>('track-trips the-sailboat');
    assertEquals(derived.trips.map((trip) => trip.id), ['2025-06-05', '2025-06-10']);

    let first = '';
    await t.step('--new makes an album of the trip, which lists the device and spans the trip', async () => {
      first = (await client.execJson<TripAlbumAnswer>('trip-album the-sailboat 2025-06-05 --new')).album;
      assertEquals(first, `${ALBUMS_ROOT}/Sailboat 2025-06-05`);
      const album = await attrs(first);
      assertEquals(album.name, 'Sailboat 2025-06-05');
      const trip = derived.trips[0];
      assertEquals(album.trip?.device, BOAT);
      assertEquals(album.trip?.day, '2025-06-05');
      assertEquals(album.trip?.timezone, 'Europe/Stockholm');
      assertEquals([album.trip?.start, album.trip?.end], [trip.start, trip.end]);
      // Its stays are numbered within the album: where it left from and where it arrived.
      assertEquals(album.trip?.stays.length, 2);
      assertEquals([album.trip?.from.stay, album.trip?.to.stay], [0, 1]);
      // The span is the trip's, as the wall clock in Stockholm (two hours ahead in June).
      assertEquals(album.timeStart, new Date(Date.parse(trip.start) + 2 * HOUR).toISOString().slice(0, 19));
      assertEquals(album.timeEnd, new Date(Date.parse(trip.end) + 2 * HOUR).toISOString().slice(0, 19));
      const devices = await client.execJson<AlbumDeviceList>(`album-device-list '${first}'`);
      assertEquals(devices.devices.map((device) => [device.path, device.source]), [[BOAT, 'added']]);
      assertEquals((await list()).trips.map((entry) => entry.album), [first, undefined]);
    });

    await t.step('a trip is one album, and an album holds one trip', async () => {
      await cmd.shouldFailWith('trip-album the-sailboat 2025-06-05 --new', 'is the album');
      await cmd.shouldFailWith(`trip-album the-sailboat 2025-06-10 --album='${first}'`, 'holds the trip 2025-06-05');
      await cmd.shouldFailWith('trip-album the-sailboat 2025-07-01 --new', 'no trip');
      await cmd.shouldFailWith('trip-album the-sailboat 2025-06-05', 'usage');
      await cmd.shouldFailWith('trip-album the-sailboat 2025-06-05 --detach --new', 'usage');
    });

    await t.step('--album makes an album that is there the trip, which is no other trip candidate then', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/Archipelago --name Archipelago`);
      await cmd.shouldSucceed(`trip-album the-sailboat 2025-06-10 --album=${ALBUMS_ROOT}/Archipelago`);
      const trip = (await attrs(`${ALBUMS_ROOT}/Archipelago`)).trip!;
      assertEquals(trip.legs.map((leg) => leg.day), ['2025-06-10', '2025-06-11']);
      assertEquals(trip.stays.map((stay) => stay.kind), ['rest', 'overnight', 'rest']);
      assertEquals(trip.legs[0].to.stay, 1);
      const listed = await list();
      assertEquals(listed.trips.map((entry) => entry.album), [first, `${ALBUMS_ROOT}/Archipelago`]);
      assert(listed.trips.every((entry) => entry.albums.length === 0), 'albums holding a trip are no candidates');
      // Giving the album its own trip again writes it again.
      await cmd.shouldSucceed(`trip-album the-sailboat 2025-06-10 --album=${ALBUMS_ROOT}/Archipelago`);
    });

    await t.step('--detach takes the trip off its album, which then has no span without photos', async () => {
      assertEquals((await client.execJson<TripAlbumAnswer>('trip-album the-sailboat 2025-06-05 --detach')).album, first);
      const album = await attrs(first);
      assertEquals([album.trip, album.timeStart, album.timeEnd], [undefined, undefined, undefined]);
      assertEquals((await list()).trips[0].album, undefined);
      await cmd.shouldFailWith('trip-album the-sailboat 2025-06-05 --detach', "no album's");
    });

    await t.step('the album of an ongoing trip grows with it as track-trips runs', async () => {
      await cmd.shouldSucceed(`mknode -p -t device ${CAR} --as name=Car --as kind=car`);
      await cmd.shouldSucceed('track-create the-car');
      const now = Math.floor(Date.now() / HOUR) * HOUR;
      const parked = Array.from({ length: 16 }, (_, i) => fixAt(now - 6 * DAY + i * 6 * HOUR, 0));
      const away = Array.from({ length: 3 }, (_, i) => fixAt(now - 4 * HOUR + i * HOUR, (i + 1) * 5_000));
      await cmd.shouldSucceed(`track-append ${CAR} --json '${JSON.stringify([...parked, ...away])}'`);
      const trips = await client.execJson<DeviceTrips>('track-trips the-car');
      assertEquals(trips.trips.map((trip) => trip.ongoing), [true]);
      const { album } = await client.execJson<TripAlbumAnswer>(`trip-album the-car ${trips.trips[0].id} --new --name 'Road trip'`);
      assertEquals(album, `${ALBUMS_ROOT}/Road trip`);
      const before = (await attrs(album)).trip!;

      await cmd.shouldSucceed(`track-append ${CAR} --json '${JSON.stringify([fixAt(now - HOUR / 2, 25_000)])}'`);
      await cmd.shouldSucceed('track-trips the-car');
      const after = await attrs(album);
      assertEquals(after.trip?.start, before.start);
      assertEquals(after.trip?.end, fixAt(now - HOUR / 2, 0).ts);
      assert(after.trip!.distanceM > before.distanceM, 'the album trip grew');
      assertEquals(after.timeEnd, after.trip!.end.slice(0, 19));
    });
  } finally {
    await testCtx.teardown();
  }
});
