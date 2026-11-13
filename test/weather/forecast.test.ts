/**
 * weather-forecast against stub Open-Meteo and Nominatim servers on loopback: it asks nobody when
 * `CFG_WEATHER` is off; it answers the weather now, the hours from the one under way and the days
 * by the place's calendar; the same forecast asked again within minutes is answered from memory,
 * and so is a place found by name; a failing service fails it. The places and the weather are
 * invented.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { WeatherForecast } from '@archive/weather/api';

const HOUR = 3_600;

Deno.test({
  name: 'weather-forecast',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const testCtx = createTestContext({ modules: ['archive'] });
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();

  /** What the stubs were asked: `forecast <lat>,<lng> <days>` and `nominatim <query>`. */
  const asked: string[] = [];
  // The stub's hours start at midnight UTC two hours ago at the latest, as the service's start at the place's midnight.
  const thisHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const midnight = Math.floor((thisHour - 2 * HOUR) / 86_400) * 86_400;
  const forecast = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const query = new URL(req.url).searchParams;
    const [lat, lng, days] = ['latitude', 'longitude', 'forecast_days'].map((key) => query.get(key)!);
    asked.push(`forecast ${lat},${lng} ${days}`);
    if (lat === '10') return new Response('broken', { status: 500 });
    const hours = Number(days) * 24;
    const hourly = Array.from({ length: hours }, (_, i) => midnight + i * HOUR);
    return Response.json({
      latitude: Number(lat),
      longitude: Number(lng),
      utc_offset_seconds: 3600,
      timezone: 'Europe/Stockholm',
      current: {
        time: thisHour + 900,
        interval: 900,
        temperature_2m: 4.2,
        apparent_temperature: 1.5,
        is_day: 1,
        precipitation: 0,
        weather_code: 2,
        cloud_cover: 60,
        wind_speed_10m: 3.5,
        wind_direction_10m: 270,
        wind_gusts_10m: 7,
      },
      hourly: {
        time: hourly,
        temperature_2m: hourly.map((_, i) => i / 10),
        precipitation_probability: hourly.map(() => null),
        precipitation: hourly.map(() => 0.2),
        weather_code: hourly.map(() => 61),
        wind_speed_10m: hourly.map(() => 4),
        wind_direction_10m: hourly.map(() => 180),
        is_day: hourly.map(() => 0),
      },
      daily: {
        // Midnight at the place, an hour before midnight UTC.
        time: Array.from({ length: Number(days) }, (_, i) => midnight + i * 86_400 - HOUR),
        weather_code: Array.from({ length: Number(days) }, (_, i) => i),
        temperature_2m_max: Array.from({ length: Number(days) }, () => 8),
        temperature_2m_min: Array.from({ length: Number(days) }, () => -1),
        precipitation_sum: Array.from({ length: Number(days) }, () => 1.5),
        precipitation_probability_max: Array.from({ length: Number(days) }, () => 70),
        wind_speed_10m_max: Array.from({ length: Number(days) }, () => 9),
        wind_direction_10m_dominant: Array.from({ length: Number(days) }, () => 225),
        sunrise: Array.from({ length: Number(days) }, (_, i) => midnight + i * 86_400 + 7 * HOUR),
        sunset: Array.from({ length: Number(days) }, () => null),
      },
    });
  });
  const nominatim = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const query = new URL(req.url).searchParams.get('q');
    asked.push(`nominatim ${query}`);
    return Response.json(query === 'Exempelby' ? [{ lat: '59.31', lon: '18.02', display_name: 'Exempelby, Exempelkommun' }] : []);
  });
  const urls = `NOMINATIM_SEARCH_URL=http://localhost:${(nominatim.addr as Deno.NetAddr).port}/search ` +
    `OPEN_METEO_FORECAST_URL=http://localhost:${(forecast.addr as Deno.NetAddr).port}/v1/forecast`;
  const forecastOf = (args: string) => client.execJson<WeatherForecast>(`${urls} weather-forecast ${args}`);

  try {
    await t.step('nothing is asked when CFG_WEATHER is off', async () => {
      const off = await client.exec(`CFG_WEATHER=false ${urls} weather-forecast 59.31 18.02`);
      assertEquals(off.success, false);
      assertStringIncludes(off.error ?? '', 'CFG_WEATHER');
      assertEquals(asked, []);
    });

    await t.step("the weather now, the hours from the one under way and the days by the place's calendar", async () => {
      const answer = await forecastOf('59.31 18.02 --days=3 --hours=5');
      assertEquals(asked, ['forecast 59.31,18.02 3']);
      assertEquals([answer.timezone, answer.place], ['Europe/Stockholm', undefined]);
      assertEquals(answer.now, {
        time: new Date((thisHour + 900) * 1000).toISOString(),
        code: 2,
        isDay: true,
        temperature: 4.2,
        feelsLike: 1.5,
        precipitation: 0,
        windSpeed: 3.5,
        windGusts: 7,
        windDirection: 270,
        cloudCover: 60,
      });
      assertEquals(answer.hours.length, 5);
      assertEquals(answer.hours[0], {
        time: new Date(thisHour * 1000).toISOString(),
        code: 61,
        isDay: false,
        temperature: (thisHour - midnight) / HOUR / 10,
        precipitation: 0.2,
        windSpeed: 4,
        windDirection: 180,
      });
      const today = new Date(midnight * 1000).toISOString().slice(0, 10);
      assertEquals(answer.days.map((day) => day.date)[0], today);
      assertEquals(answer.days.length, 3);
      assertEquals(answer.days[1], {
        date: new Date((midnight + 86_400) * 1000).toISOString().slice(0, 10),
        code: 1,
        temperatureMin: -1,
        temperatureMax: 8,
        precipitation: 1.5,
        precipitationChance: 70,
        windSpeedMax: 9,
        windDirection: 225,
        sunrise: new Date((midnight + 86_400 + 7 * HOUR) * 1000).toISOString(),
      });
    });

    await t.step('hours past the days shown are fetched with more days; the same forecast again is answered from memory', async () => {
      asked.length = 0;
      const answer = await forecastOf('59.31 18.02 --days=1 --hours=60');
      assertEquals([answer.days.length, answer.hours.length], [1, 60]);
      assertEquals(asked, ['forecast 59.31,18.02 4']);
      asked.length = 0;
      await forecastOf('59.31 18.02 --days=3 --hours=5');
      assertEquals(asked, []);
    });

    await t.step('--place finds a place by name once', async () => {
      asked.length = 0;
      const first = await forecastOf('--place=Exempelby --days=2');
      assertEquals([first.place, first.lat, first.lng], ['Exempelby, Exempelkommun', 59.31, 18.02]);
      await forecastOf('--place=Exempelby --days=2');
      assertEquals(asked, ['nominatim Exempelby', 'forecast 59.31,18.02 2']);
      const nowhere = await client.exec(`${urls} weather-forecast --place=Ingenstans`);
      assertEquals(nowhere.success, false);
      assertStringIncludes(nowhere.error ?? '', 'no place called "Ingenstans"');
    });

    await t.step('the text form reads as a forecast', async () => {
      const text = await client.execString(`${urls} weather-forecast 59.31 18.02 --days=3 --hours=5`, { json: false });
      assertStringIncludes(text, 'Europe/Stockholm');
      assertStringIncludes(text, 'now  4.2 °C, feels like 1.5 °C, partly cloudy, wind 3.5 m/s from W');
      assertStringIncludes(text, 'mainly clear');
    });

    await t.step('a bad request is refused; a failing service fails it', async () => {
      assertEquals((await client.exec(`${urls} weather-forecast 59.31 18.02 --days=17`)).success, false);
      assertEquals((await client.exec(`${urls} weather-forecast 59.31`)).success, false);
      const failed = await client.exec(`${urls} weather-forecast 10 10`);
      assertEquals(failed.success, false);
      assertStringIncludes(failed.error ?? '', 'returned 500');
    });
  } finally {
    await forecast.shutdown();
    await nominatim.shutdown();
    await testCtx.teardown();
  }
});
