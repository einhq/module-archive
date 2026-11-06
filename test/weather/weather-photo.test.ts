/**
 * weather-photo against a stub Open-Meteo on loopback: the weather of the photo's point and capture
 * time lands on its position node and `media-details` answers it; a position whose weather is for
 * its point and time is not asked again, one moved or retimed is; nothing is asked while
 * `CFG_WEATHER` is off; a failed lookup keeps the weather it had; a photo that loses its capture
 * time loses its weather. The photos and their weather are invented.
 */
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import type { MediaDetails } from '@archive/media/api';
import type { WeatherPhotoResult, WeatherReading } from '@archive/weather/api';

const HOUR = 3_600_000;

Deno.test({ name: 'weather-photo', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const testCtx = createTestContext({ modules: ['archive'] });
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  // Every hour's temperature is its hour of the day, the wind 3 m/s from the south-west, 25 % cloud.
  let down = false;
  const asked: string[] = [];
  const openMeteo = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const query = new URL(req.url).searchParams;
    const [start, end] = [query.get('start_date')!, query.get('end_date')!];
    asked.push(`${query.get('latitude')},${query.get('longitude')} ${start}`);
    if (down) return new Response('busy', { status: 503 });
    const hours = Array.from({ length: (Date.parse(end) - Date.parse(start)) / HOUR + 24 }, (_, i) => i % 24);
    return Response.json({
      latitude: Number(query.get('latitude')),
      longitude: Number(query.get('longitude')),
      hourly: { time: [], temperature_2m: hours, wind_speed_10m: hours.map(() => 3), wind_direction_10m: hours.map(() => 225), cloud_cover: hours.map(() => 25) },
    });
  });
  const settings = `CFG_WEATHER_SMHI_KM=0 OPEN_METEO_ARCHIVE_URL=http://localhost:${(openMeteo.addr as Deno.NetAddr).port}/v1/archive`;
  const photo = '/photos/IMG_0001.jpg';
  const position = `${photo}/position`;
  const run = (on = '') => client.execJson<WeatherPhotoResult>(`${on} ${settings} weather-photo ${position}`);
  const held = async () => (await client.execJson<{ weather?: WeatherReading }>(`attrs ${position}`)).weather;

  try {
    await cmd.shouldSucceed(`mkdir -p /photos && mknode -t file ${photo} --as takenAtUtc=2024-07-14T14:40:00Z && mknode -t position ${position}`);
    await cmd.shouldSucceed(`position-set ${position} --lat=48.8 --lng=-3.1`);

    await t.step('nothing is asked while CFG_WEATHER is off', async () => {
      assertEquals(await run('CFG_WEATHER=false'), { position, skipped: 'off' });
      assertEquals([asked, await held()], [[], undefined]);
    });

    await t.step('the weather of the nearest hour lands on the position, and media-details answers it', async () => {
      const result = await run();
      assertEquals('weather' in result && result.weather.temperature?.value, 15);
      const weather = await held();
      assertEquals([weather?.time, weather?.lat, weather?.lng, weather?.windDirection?.value, weather?.cloudCover?.value], ['2024-07-14T14:40:00.000Z', 48.8, -3.1, 225, 25]);
      const details = await client.execJson<MediaDetails>(`media-details ${photo}`);
      assertEquals(details.position?.weather?.temperature?.value, 15);
    });

    await t.step('weather for the same point and time is not asked again', async () => {
      asked.length = 0;
      await cmd.shouldSucceed('rm -r /archive/sources/weather');
      assertEquals(await run(), { position, skipped: 'current' });
      assertEquals(asked, []);
    });

    await t.step('a photo retimed or moved is looked up again', async () => {
      await cmd.shouldSucceed(`attrs ${photo} -s takenAtUtc=2024-07-14T09:05:00Z`);
      assertEquals('weather' in await run(), true);
      assertEquals((await held())?.temperature?.value, 9);
      await cmd.shouldSucceed(`position-set ${position} --lat=48.3 --lng=-3.1`);
      await run();
      assertEquals([(await held())?.lat, asked.at(-1)], [48.3, '48.25,-3 2024-07-01']);
    });

    await t.step('a failed lookup fails and keeps the weather the photo had', async () => {
      await cmd.shouldSucceed(`attrs ${photo} -s takenAtUtc=2024-08-01T12:00:00Z`);
      down = true;
      await cmd.shouldFail(`${settings} weather-photo ${position}`);
      down = false;
      assertEquals((await held())?.time, '2024-07-14T09:05:00.000Z');
    });

    await t.step('a photo that loses its capture time loses its weather', async () => {
      await cmd.shouldSucceed(`attrs ${photo} -s takenAtUtc=`);
      assertEquals(await run(), { position, skipped: 'no time', removed: true });
      assertEquals(await held(), undefined);
    });
  } finally {
    await openMeteo.shutdown();
    await testCtx.teardown();
  }
});
