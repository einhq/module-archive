/**
 * SMHI's meteorological observations (metobs): which stations measure a parameter, and a
 * station's hourly values of it (`@archive/weather/smhi`).
 *
 * The service is free and needs no key. A station's values come in two periods, each one CSV
 * file: `corrected-archive`, its whole quality-checked history up to about three months ago (often
 * several megabytes), and `latest-months`, the last four months as observed. The two overlap.
 */
import type { WeatherParameter } from '@archive/weather/api';
import { weatherFetch } from '@archive/weather/fetch';

export const SMHI_METOBS_URL = 'https://opendata-download-metobs.smhi.se/api/version/1.0';

/** SMHI's id of each parameter; every one is observed once an hour. */
export const SMHI_PARAMETERS: Record<WeatherParameter, number> = { temperature: 1, windDirection: 3, windSpeed: 4, cloudCover: 16 };

export type SmhiPeriod = 'corrected-archive' | 'latest-months';

/** A station measuring a parameter, and when it did, in ms. An active station still does: its `to` is when the catalogue was made. */
export type SmhiStation = { id: number; name: string; lat: number; lng: number; from: number; to: number; active: boolean };

/** A station's values of a parameter over a period: the hours the file says it covers (inclusive, ms) and each hour's value where there is one. */
export type SmhiSeries = { from: number; to: number; values: Map<number, number> };

type CatalogueStation = { id?: unknown; name?: unknown; latitude?: unknown; longitude?: unknown; from?: unknown; to?: unknown; active?: unknown };

/** The stations that measure a parameter or once did. */
export const fetchSmhiStations = async (base: string, parameter: number): Promise<SmhiStation[]> => {
  const response = await weatherFetch(new URL(`${base}/parameter/${parameter}.json`));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`SMHI has no parameter ${parameter}`);
  }
  const answer = await response.json() as { station?: CatalogueStation[] };
  return (answer.station ?? []).flatMap((s) =>
    typeof s.id === 'number' && typeof s.latitude === 'number' && typeof s.longitude === 'number'
      ? [{
        id: s.id,
        name: typeof s.name === 'string' ? s.name : String(s.id),
        lat: s.latitude,
        lng: s.longitude,
        from: typeof s.from === 'number' ? s.from : 0,
        to: typeof s.to === 'number' ? s.to : 0,
        active: s.active === true,
      }]
      : []
  );
};

/** A station's values of a parameter over a period; undefined when it has none there. */
export const fetchSmhiSeries = async (base: string, parameter: number, station: number, period: SmhiPeriod): Promise<SmhiSeries | undefined> => {
  const response = await weatherFetch(new URL(`${base}/parameter/${parameter}/station/${station}/period/${period}/data.csv`));
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  return parseSmhiCsv(await response.text());
};

const HOUR_MS = 3_600_000;

/** A `YYYY-MM-DD` and `HH:MM:SS` in UTC, as SMHI writes them, in ms. */
const utc = (date: string, time: string): number => Date.parse(`${date}T${time}Z`);

/**
 * An SMHI data file: blocks about the station and the parameter, then the data under the header
 * `Datum;Tid (UTC);<parameter>;Kvalitet`, one `date;time;value;quality` row per observation. Beside
 * the first rows, the file says which span it covers (`Tidsperiod (fr.o.m.) = …` and `(t.o.m.)`);
 * where it does not, the first and last rows do. Values are kept by their hour, whatever their
 * quality code: SMHI leaves out those it rejects.
 */
export const parseSmhiCsv = (text: string): SmhiSeries => {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith('Datum;Tid'));
  if (header < 0) throw new Error('not an SMHI data file');
  const values = new Map<number, number>();
  let first = Infinity;
  let last = -Infinity;
  for (const line of lines.slice(header + 1)) {
    const [date, time, raw] = line.split(';');
    if (!date || !time || !raw) continue;
    const ms = utc(date, time);
    const value = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(ms) || !Number.isFinite(value)) continue;
    const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
    values.set(hour, value);
    first = Math.min(first, hour);
    last = Math.max(last, hour);
  }
  const stated = (label: string): number | undefined => {
    const match = text.match(new RegExp(`Tidsperiod \\(${label}\\) = (\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2})`));
    return match ? utc(match[1], match[2]) : undefined;
  };
  const from = stated('fr\\.o\\.m\\.');
  const to = stated('t\\.o\\.m\\.');
  return {
    from: from === undefined ? first : Math.ceil(from / HOUR_MS) * HOUR_MS,
    to: to === undefined ? last : Math.floor(to / HOUR_MS) * HOUR_MS,
    values,
  };
};
