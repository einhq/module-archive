/**
 * track-weather on a device's trips, against a stub Open-Meteo on loopback: it asks nobody when
 * `CFG_WEATHER` is off, and does by default; each leg and the whole trip get the weather of the track's hours, the wind's
 * direction averaged as vectors; the album made of the trip gets it too; a trip that has its
 * weather is not sampled again, and deriving the trips again keeps it; a failed lookup leaves the
 * weather as it was and the next run asks again. The track and its weather are invented.
 */

import { ALBUMS_ROOT, DEVICES_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import type { TrackWeather, Trip, TripLeg, TripList } from '@archive/location/api';
import { hourlyFixes, keepTripWeather, summarizeWeather } from '@archive/location/trip-weather';
import type { AlbumTrip } from '@archive/media/api';
import type { WeatherReading } from '@archive/weather/api';

const M2DEG = 1 / 111_320;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2025, 5, 1);

Deno.test('hourlyFixes takes the fix nearest each whole hour, and the middle hour of a span within one', () => {
  const fixes = [0, 20, 55, 70, 130].map((minutes) => ({ ms: T0 + minutes * 60_000, lat: minutes, lng: 0 }));
  const hours = hourlyFixes(fixes, T0 + 10 * 60_000, T0 + 130 * 60_000);
  assertEquals(hours.map((fix) => [(fix.ms - T0) / HOUR, fix.lat]), [[1, 55], [2, 130]]);
  assertEquals(hourlyFixes(fixes, T0 + 10 * 60_000, T0 + 50 * 60_000).map((fix) => [(fix.ms - T0) / HOUR, fix.lat]), [[1, 55]]);
  assertEquals(hourlyFixes([], T0, T0 + DAY), []);
});

Deno.test('summarizeWeather: means, extremes, and the wind direction as the mean of vectors', () => {
  const reading = (temperature: number, windSpeed: number, windDirection: number): WeatherReading => {
    const value = (v: number) => ({ value: v, at: '', source: { kind: 'open-meteo' as const, lat: 0, lng: 0 } });
    return { lat: 0, lng: 0, time: '', temperature: value(temperature), windSpeed: value(windSpeed), windDirection: value(windDirection) };
  };
  assertEquals(summarizeWeather([reading(12, 3, 350), reading(15.54, 6.04, 20), { lat: 0, lng: 0, time: '' }]), {
    hours: 3,
    windSpeed: 4.5,
    windMax: 6,
    windDirection: 5,
    temperatureMin: 12,
    temperatureMax: 15.5,
  });
  assertEquals(summarizeWeather([]), { hours: 0 });
});

Deno.test('keepTripWeather keeps a leg with the same span, and a trip only while its legs all keep theirs', () => {
  const weather = { hours: 2, cloudCover: 50 };
  const leg = (day: number): TripLeg => ({
    day: `d${day}`,
    start: `s${day}`,
    end: `e${day}`,
    from: { lat: 0, lng: 0, time: '' },
    to: { lat: 0, lng: 0, time: '' },
    distanceM: 1,
    bounds: { north: 0, south: 0, east: 0, west: 0 },
  });
  const trip = (legs: TripLeg[]): Trip => ({
    id: 'a',
    day: 'd1',
    start: 's1',
    end: legs.at(-1)!.end,
    ongoing: false,
    from: { lat: 0, lng: 0, time: '' },
    to: { lat: 0, lng: 0, time: '' },
    destination: { lat: 0, lng: 0 },
    distanceM: 1,
    maxDistanceM: 1,
    days: [],
    legs,
    bounds: { north: 0, south: 0, east: 0, west: 0 },
    albums: [],
  });
  const held = [{ ...trip([{ ...leg(1), weather }, { ...leg(2), weather }]), weather }];
  assertEquals(keepTripWeather([trip([leg(1), leg(2)])], held)[0].weather, weather);
  const longer = keepTripWeather([trip([leg(1), leg(2), leg(3)])], held)[0];
  assertEquals([longer.weather, ...longer.legs.map((kept) => kept.weather)], [undefined, weather, weather, undefined]);
});

Deno.test({
  name: 'track-weather',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const testCtx = createTestContext({ modules: ['archive'] });
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  // Each hour's weather by its hour of the day: the temperature is the hour, the wind half of it,
  // from 350° at an even hour and 10° at an odd one.
  let down = false;
  const asked: string[] = [];
  const openMeteo = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const query = new URL(req.url).searchParams;
    const [start, end] = [query.get('start_date')!, query.get('end_date')!];
    asked.push(`${start}..${end}`);
    if (down) return new Response('busy', { status: 503 });
    const hours = Array.from({ length: (Date.parse(end) - Date.parse(start)) / HOUR + 24 }, (_, i) => i % 24);
    return Response.json({
      latitude: Number(query.get('latitude')),
      longitude: Number(query.get('longitude')),
      hourly: {
        time: [],
        temperature_2m: hours,
        wind_speed_10m: hours.map((hour) => hour / 2),
        wind_direction_10m: hours.map((hour) => hour % 2 ? 10 : 350),
        cloud_cover: hours.map(() => 40),
      },
    });
  });
  const settings = `CFG_WEATHER_SMHI_KM=0 OPEN_METEO_ARCHIVE_URL=http://localhost:${(openMeteo.addr as Deno.NetAddr).port}/v1/archive`;
  const weather = (args = '', on = '') => client.execJson<TrackWeather>(`${on} ${settings} track-weather the-sailboat ${args}`);
  const list = () => client.execJson<TripList>('trip-list the-sailboat');

  // Four days at a mooring, a morning's sail 10 km north, four days at the next.
  const fix = (d: number, h: number, northM: number) => ({ lat: 59.02 + northM * M2DEG, lng: 18, ts: new Date(T0 + d * DAY + h * HOUR).toISOString() });
  const rest = (d: number, northM: number) => Array.from({ length: 16 }, (_, i) => fix(d + Math.floor(i / 4), (i % 4) * 6, northM));
  const sail = Array.from({ length: 5 }, (_, i) => fix(4, 9 + i, 2_500 * i));

  try {
    await cmd.shouldSucceed(`mknode -p -t device ${DEVICES_ROOT}/the-sailboat --as name=the-sailboat --as kind=boat`);
    await cmd.shouldSucceed('track-create the-sailboat');
    await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/the-sailboat --json '${JSON.stringify([...rest(0, 0), ...sail, ...rest(5, 10_000)])}'`);
    await cmd.shouldSucceed('track-trips the-sailboat');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed('trip-album the-sailboat 2025-06-05 --new --name Out');

    await t.step('nothing is asked when CFG_WEATHER is off', async () => {
      assertEquals(await weather('', 'CFG_WEATHER=false'), { device: `${DEVICES_ROOT}/the-sailboat`, off: true, legs: 0, hours: 0, failed: 0, requests: 0 });
      assertEquals(asked, []);
    });

    await t.step('each leg and the trip get the weather of the hours along the track', async () => {
      const sampled = await weather();
      assertEquals([sampled.legs, sampled.failed, sampled.requests], [1, 0, 1]);
      const [trip] = (await list()).trips;
      // The leg is 10:00 to 12:00, the hours at the moorings being theirs: 350°, 10° and 350° average to 357°.
      const expected = { hours: 3, windSpeed: 5.5, windMax: 6, windDirection: 357, temperatureMin: 10, temperatureMax: 12, cloudCover: 40 };
      assertEquals(sampled.hours, 3);
      assertEquals(trip.legs.map((leg) => leg.weather), [expected]);
      assertEquals(trip.weather, expected);
      const album = (await client.execJson<{ trip?: AlbumTrip }>(`attrs ${ALBUMS_ROOT}/Out`)).trip;
      assertEquals([album?.weather, album?.legs[0].weather], [expected, expected]);
    });

    await t.step('a trip with its weather is not sampled again, and deriving the trips again keeps it', async () => {
      asked.length = 0;
      assertEquals((await weather()).legs, 0);
      await cmd.shouldSucceed('track-trips the-sailboat --full');
      assertEquals((await list()).trips[0].weather?.hours, 3);
      assertEquals(asked, []);
    });

    await t.step('a failed lookup keeps the weather it had, and the next run asks again', async () => {
      // The month is kept: a lookup asks the service only for a month it does not hold.
      await cmd.shouldSucceed('rm -r /archive/sources/weather');
      down = true;
      const failed = await weather('--full');
      assertEquals([failed.legs, failed.failed], [0, 1]);
      assertEquals((await list()).trips[0].weather?.hours, 3);
      down = false;
      assertEquals((await weather('--full')).legs, 1);
    });
  } finally {
    await openMeteo.shutdown();
    await testCtx.teardown();
  }
});
