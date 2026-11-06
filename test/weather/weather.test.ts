/**
 * weather against stub SMHI and Open-Meteo servers on loopback: it asks nobody when
 * `CFG_WEATHER` is off; near a station each parameter is that station's observation of the nearest
 * hour, and one it did not observe, or that no station near enough measures, comes from
 * Open-Meteo's cell; an old hour is read from SMHI's archive and a recent one from its latest
 * months; what was fetched answers again without asking, other years of the same download too;
 * `--to` answers every hour of a span;
 * abroad Open-Meteo answers alone; a time to come has no weather; a failing service fails the
 * lookup. The stations and their values are invented.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { WeatherReading } from '@archive/weather/api';
import { parseSmhiCsv } from '@archive/weather/smhi';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

Deno.test('parseSmhiCsv reads the data rows and the span the file states', () => {
  const csv = [
    'Stationsnamn;Stationsnummer;Stationsnät;Mäthöjd (meter över marken)',
    'Exempelstation;1001;SMHIs stationsnät;2.0',
    '',
    'Tidsperiod (fr.o.m);Tidsperiod (t.o.m);Höjd (meter över havet);Latitud (decimalgrader);Longitud (decimalgrader)',
    '1990-01-01 00:00:00;2025-07-31 23:59:59;12.0;59.3000;18.0000',
    '',
    'Datum;Tid (UTC);Lufttemperatur;Kvalitet;;Tidsutsnitt:',
    '2025-06-25;01:00:00;15.5;G;;Data från senaste fyra månaderna',
    '2025-06-25;02:00:00;-0.4;Y;;Tidsperiod (fr.o.m.) = 2025-06-25 00:00:01 (UTC)',
    '2025-06-25;04:00:00;14.7;G;;Tidsperiod (t.o.m.) = 2025-07-31 23:59:59 (UTC)',
    '2025-06-25;05:00:00;;G',
  ].join('\n');
  const series = parseSmhiCsv(csv);
  assertEquals([new Date(series.from).toISOString(), new Date(series.to).toISOString()], ['2025-06-25T01:00:00.000Z', '2025-07-31T23:00:00.000Z']);
  assertEquals([...series.values].map(([hour, value]) => [new Date(hour).toISOString().slice(11, 13), value]), [['01', 15.5], ['02', -0.4], ['04', 14.7]]);
});

/** The value the SMHI stub gives a parameter at an hour, unless it is the one hour of the archive it leaves out. */
const smhiValue = (parameter: number, hour: number): number => parameter * 10 + new Date(hour).getUTCHours() / 10;
const GAP = Date.UTC(2019, 6, 1, 13);
const ARCHIVE = [Date.UTC(2019, 5, 1), Date.UTC(2020, 0, 31, 23)];

const csvOf = (parameter: number, from: number, to: number, skip?: number): string => {
  const rows: string[] = [];
  for (let hour = from; hour <= to; hour += HOUR) {
    if (hour === skip) continue;
    const at = new Date(hour).toISOString();
    rows.push(`${at.slice(0, 10)};${at.slice(11, 19)};${smhiValue(parameter, hour)};G`);
  }
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  rows[0] += `;;Tidsperiod (fr.o.m.) = ${stamp(from)} (UTC)`;
  rows[1] += `;;Tidsperiod (t.o.m.) = ${stamp(to + HOUR - 1000)} (UTC)`;
  return ['Stationsnamn;Stationsnummer', 'Exempelstation;1001', '', 'Datum;Tid (UTC);Värde;Kvalitet;;Tidsutsnitt:', ...rows].join('\n');
};

Deno.test({
  name: 'weather',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const testCtx = createTestContext({ modules: ['archive'] });
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();

  /** What the stubs were asked: `smhi <path>` and `open-meteo <lat>,<lng> <start>..<end>`. */
  const asked: string[] = [];
  const now = Date.now();
  const recent = [Math.floor((now - 120 * DAY) / HOUR) * HOUR, Math.floor(now / HOUR) * HOUR - HOUR];
  const station = (id: number, name: string, latitude: number, longitude: number) => ({ id, name, latitude, longitude, from: Date.UTC(1990, 0, 1), to: now, active: true });
  const smhi = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname.replace(/^\/metobs/, '');
    asked.push(`smhi ${path}`);
    const catalogue = path.match(/^\/parameter\/(\d+)\.json$/);
    if (catalogue) {
      // 1001 measures temperature and wind beside the place; 1002, 55 km north, cloud cover; 1003 temperature, elsewhere.
      const parameter = Number(catalogue[1]);
      const stations = parameter === 16 ? [station(1002, 'Fjärrstation', 59.8, 18)] : [station(1001, 'Exempelstation', 59.3, 18)];
      if (parameter === 1) stations.push(station(1003, 'Trasigstation', 57.7, 11.97));
      return Response.json({ key: String(parameter), station: stations });
    }
    const data = path.match(/^\/parameter\/(\d+)\/station\/(\d+)\/period\/([a-z-]+)\/data\.csv$/);
    if (!data) return new Response('not found', { status: 404 });
    const [parameter, id, period] = [Number(data[1]), Number(data[2]), data[3]];
    if (id === 1003) return new Response('broken', { status: 500 });
    if (id !== 1001) return new Response('not found', { status: 404 });
    return new Response(period === 'corrected-archive' ? csvOf(parameter, ARCHIVE[0], ARCHIVE[1], parameter === 1 ? GAP : undefined) : csvOf(parameter, recent[0], recent[1]));
  });
  const openMeteo = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const query = new URL(req.url).searchParams;
    const [lat, lng, start, end] = ['latitude', 'longitude', 'start_date', 'end_date'].map((key) => query.get(key)!);
    asked.push(`open-meteo ${lat},${lng} ${start}..${end}`);
    const hours = (Date.parse(end) - Date.parse(start)) / HOUR + 24;
    const column = (value: number) => Array.from({ length: hours }, () => value);
    return Response.json({
      latitude: Number(lat),
      longitude: Number(lng),
      hourly: { time: [], temperature_2m: column(Number(lat)), wind_speed_10m: column(3.5), wind_direction_10m: column(270), cloud_cover: column(40) },
    });
  });
  const urls = `SMHI_METOBS_URL=http://localhost:${(smhi.addr as Deno.NetAddr).port}/metobs ` +
    `OPEN_METEO_ARCHIVE_URL=http://localhost:${(openMeteo.addr as Deno.NetAddr).port}/v1/archive`;
  const weather = (args: string, settings = '') => client.execJson<WeatherReading>(`${settings} ${urls} weather ${args}`);
  const sources = (reading: WeatherReading) =>
    (['temperature', 'windSpeed', 'windDirection', 'cloudCover'] as const).map((parameter) => {
      const value = reading[parameter];
      return value && [value.value, value.source.kind === 'smhi' ? value.source.station : `${value.source.lat},${value.source.lng}`];
    });

  try {
    await t.step('nothing is asked when CFG_WEATHER is off', async () => {
      const off = await client.exec(`CFG_WEATHER=false ${urls} weather 59.31 18.02 2019-07-01T12:20`);
      assertEquals(off.success, false);
      assertStringIncludes(off.error ?? '', 'CFG_WEATHER');
      assertEquals(asked, []);
    });

    await t.step("near a station, each parameter is its observation of the nearest hour; one it does not measure is Open-Meteo's", async () => {
      const reading = await weather('59.31 18.02 2019-07-01T12:20');
      assertEquals(sources(reading), [[11.2, 1001], [41.2, 1001], [31.2, 1001], [40, '59.25,18']]);
      assertEquals(reading.temperature?.at, '2019-07-01T12:00:00.000Z');
      assertEquals(reading.temperature?.source, { kind: 'smhi', station: 1001, name: 'Exempelstation', distanceM: 1589 });
      assertEquals(asked.sort(), [
        'open-meteo 59.25,18 2019-07-01..2019-07-31',
        'smhi /parameter/1.json',
        'smhi /parameter/1/station/1001/period/corrected-archive/data.csv',
        'smhi /parameter/16.json',
        'smhi /parameter/3.json',
        'smhi /parameter/3/station/1001/period/corrected-archive/data.csv',
        'smhi /parameter/4.json',
        'smhi /parameter/4/station/1001/period/corrected-archive/data.csv',
      ]);
      const kept = await client.execJson<{ covered: number[][]; values: (number | null)[] }>('cat /archive/sources/weather/smhi/1001/1/2019.json');
      assertEquals(kept.covered, [[ARCHIVE[0], Date.UTC(2019, 11, 31, 23)]]);
    });

    await t.step('asked again, the kept answers answer, for the hour the station missed and for the next year of the download too', async () => {
      asked.length = 0;
      assertEquals(sources(await weather('59.31 18.02 2019-07-01T12:20')), [[11.2, 1001], [41.2, 1001], [31.2, 1001], [40, '59.25,18']]);
      assertEquals(sources(await weather('59.31 18.02 2019-07-01T13:00')), [[59.25, '59.25,18'], [41.3, 1001], [31.3, 1001], [40, '59.25,18']]);
      assertEquals(asked, []);
      assertEquals(sources(await weather('59.31 18.02 2020-01-15T06:00:00+01:00')).slice(0, 3), [[10.5, 1001], [40.5, 1001], [30.5, 1001]]);
      assertEquals(asked, ['open-meteo 59.25,18 2020-01-01..2020-01-31']);
    });

    await t.step('--to gives every hour of a span, a line each as cat -t prints a log; more than a month is refused', async () => {
      const span = await client.execString(`${urls} weather 59.31 18.02 2019-07-01T11:40 --to=2019-07-01T14:10`, { json: false });
      assertEquals(span.trim().split('\n'), [
        '2019-07-01T12:00:00.000Z\t{"temperature":11.2,"windSpeed":41.2,"windDirection":31.2,"cloudCover":40}',
        '2019-07-01T13:00:00.000Z\t{"temperature":59.25,"windSpeed":41.3,"windDirection":31.3,"cloudCover":40}',
        '2019-07-01T14:00:00.000Z\t{"temperature":11.4,"windSpeed":41.4,"windDirection":31.4,"cloudCover":40}',
      ]);
      const readings = await client.execJson<WeatherReading[]>(`${urls} weather 59.31 18.02 2019-07-01T12:00 --to=2019-07-01T13:00`);
      assertEquals(readings.map((reading) => reading.temperature?.value), [11.2, 59.25]);
      const long = await client.exec(`${urls} weather 59.31 18.02 2019-07-01 --to=2019-08-02`);
      assertEquals(long.success, false);
      assertStringIncludes(long.error ?? '', 'more than 744 hours');
    });

    await t.step("a recent hour is read from SMHI's latest months", async () => {
      asked.length = 0;
      const hour = Math.floor((now - 10 * DAY) / HOUR) * HOUR;
      const reading = await weather(`59.31 18.02 ${new Date(hour).toISOString()}`);
      assertEquals(reading.windSpeed?.value, smhiValue(4, hour));
      assertEquals(asked.filter((line) => line.startsWith('smhi')).sort(), [1, 3, 4].map((p) => `smhi /parameter/${p}/station/1001/period/latest-months/data.csv`));
    });

    await t.step('abroad, Open-Meteo answers alone, for the cell the place is in; a negative coordinate takes the flag form', async () => {
      asked.length = 0;
      const reading = await weather('--lat=48.85 --lng=-3.01 2023-08-02T09:30+02:00');
      assertEquals(sources(reading), [[48.75, '48.75,-3'], [3.5, '48.75,-3'], [270, '48.75,-3'], [40, '48.75,-3']]);
      assertEquals(reading.windSpeed?.at, '2023-08-02T08:00:00.000Z');
      assertEquals(asked, ['open-meteo 48.75,-3 2023-08-01..2023-08-31']);
      assertEquals((await client.exec(`${urls} weather 48.85 -3.01 2023-08-02`)).success, false);
    });

    await t.step('CFG_WEATHER_SMHI_KM=0 leaves SMHI out', async () => {
      asked.length = 0;
      const reading = await weather('59.31 18.02 2019-07-01T12:00', 'CFG_WEATHER_SMHI_KM=0');
      assertEquals(reading.temperature?.source.kind, 'open-meteo');
      assertEquals(asked, []);
    });

    await t.step("a cloud cover SMHI writes for a sky it could not see is Open-Meteo's", async () => {
      // Fjärrstation, 55 km north, is near enough at 60 km; its kept hour says 113, the sky obscured.
      const hour = Date.UTC(2019, 6, 1, 12);
      const index = (hour - Date.UTC(2019, 0, 1)) / HOUR;
      const kept = { station: 1002, parameter: 16, year: 2019, covered: [[hour, hour]], values: [...Array(index).fill(null), 113] };
      await client.exec(`mkdir -p /archive/sources/weather/smhi/1002/16 && echo '${JSON.stringify(kept)}' > /archive/sources/weather/smhi/1002/16/2019.json`);
      const reading = await weather('59.31 18.02 2019-07-01T12:00', 'CFG_WEATHER_SMHI_KM=60');
      assertEquals(sources(reading)[3], [40, '59.25,18']);
    });

    await t.step('a time still to come has no weather and asks nobody', async () => {
      asked.length = 0;
      const reading = await weather(`59.31 18.02 ${new Date(now + 2 * DAY).toISOString()}`);
      assertEquals(sources(reading), [undefined, undefined, undefined, undefined]);
      assertEquals(asked, []);
    });

    await t.step('a service that fails fails the lookup', async () => {
      const failed = await client.exec(`${urls} weather 57.7 11.97 2019-07-01T12:00`);
      assertEquals(failed.success, false);
      assertStringIncludes(failed.error ?? '', 'returned 500');
    });
  } finally {
    await smhi.shutdown();
    await openMeteo.shutdown();
    await testCtx.teardown();
  }
});
