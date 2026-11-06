/**
 * The weather at a place and time (`@archive/weather/at`).
 *
 * Each parameter comes from the nearest SMHI station that measured it then, if one is within
 * `smhiRadiusM` of the place; otherwise, and for an hour that station has no value for, from
 * Open-Meteo's reanalysis of the place's 0.25° cell. The value is the one of the hour nearest the
 * time.
 *
 * What the services answer is kept in `@archive/weather/cache`, so an hour is asked of them once:
 * an SMHI station's period is fetched whole and kept by year, an Open-Meteo cell by month. Within
 * one `WeatherLookup` each file is read once and each SMHI period fetched once, so one lookup can
 * answer many points, as the hours of a track.
 */
import { type Command, haversineMeters, readSettings } from '@ein/client';
import type { WeatherParameter, WeatherReading, WeatherValue } from '@archive/weather/api';
import { type OpenMeteoMonth, openMeteoMonthPath, readCache, type SmhiCatalogue, smhiCataloguePath, type SmhiYear, smhiYearPath, writeCache } from '@archive/weather/cache';
import { cellOf, fetchOpenMeteo, OPEN_METEO_ARCHIVE_URL, OPEN_METEO_FIRST_DAY } from '@archive/weather/open-meteo';
import { fetchSmhiSeries, fetchSmhiStations, SMHI_METOBS_URL, SMHI_PARAMETERS, type SmhiPeriod, type SmhiSeries, type SmhiStation } from '@archive/weather/smhi';

export const WEATHER_PARAMETERS: WeatherParameter[] = ['temperature', 'windSpeed', 'windDirection', 'cloudCover'];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * An hour younger than this is asked of SMHI's `latest-months` alone, an older one of
 * `corrected-archive` first. The archive ends three to four months back, `latest-months` reaches
 * four months back, so either holds an hour of this age.
 */
const SMHI_RECENT_MS = 110 * DAY_MS;
/** Stations open and close: a catalogue this old is fetched again. */
const CATALOGUE_MAX_AGE_MS = 30 * DAY_MS;
/** ERA5 trails by about five days, which forecasts fill in the meantime: a month fetched this long after it ended is final. */
const OPEN_METEO_SETTLED_MS = 7 * DAY_MS;
/** A month not final yet that lacks the hour asked for is fetched again once it is this old. */
const OPEN_METEO_RETRY_MS = HOUR_MS;

type WeatherLookupOptions = {
  /** SMHI's metobs API (`SMHI_METOBS_URL`). */
  smhi: string;
  /** Open-Meteo's historical weather API (`OPEN_METEO_ARCHIVE_URL`). */
  openMeteo: string;
  /** How far away an SMHI station may be; 0 asks Open-Meteo alone. */
  smhiRadiusM: number;
};

/** `CFG_WEATHER_SMHI_KM` when it is not set. */
const DEFAULT_SMHI_KM = 30;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Spans of hours sorted and joined where they overlap or meet. */
const joinSpans = (spans: [number, number][]): [number, number][] => {
  const joined: [number, number][] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = joined.at(-1);
    if (last && from <= last[1] + HOUR_MS) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
};

/** Looks the weather up from the files, and from the services where the files do not have it. */
export class WeatherLookup {
  /** How many requests went to SMHI and Open-Meteo. */
  requests = 0;
  private catalogues = new Map<number, SmhiStation[]>();
  private files = new Map<string, unknown>();
  private fetched = new Set<string>();

  constructor(private cmd: Command, private opts: WeatherLookupOptions) {}

  /**
   * The weather at a point at `time` (ms). Throws when a service it had to ask failed, so that a
   * failure is not taken for weather nobody observed.
   */
  async at(lat: number, lng: number, time: number): Promise<WeatherReading> {
    const reading: WeatherReading = { lat, lng, time: iso(time) };
    const now = Date.now();
    if (time > now) return reading;
    const hour = Math.min(Math.round(time / HOUR_MS), Math.floor(now / HOUR_MS)) * HOUR_MS;
    for (const parameter of WEATHER_PARAMETERS) {
      const value = await this.fromSmhi(parameter, lat, lng, hour);
      if (value) reading[parameter] = value;
    }
    const missing = WEATHER_PARAMETERS.filter((parameter) => !reading[parameter]);
    if (missing.length) Object.assign(reading, await this.fromOpenMeteo(missing, lat, lng, hour));
    return reading;
  }

  private async fromSmhi(parameter: WeatherParameter, lat: number, lng: number, hour: number): Promise<WeatherValue | undefined> {
    if (!(this.opts.smhiRadiusM > 0)) return undefined;
    const id = SMHI_PARAMETERS[parameter];
    let best: { station: SmhiStation; distance: number } | undefined;
    for (const station of await this.stations(id)) {
      if (hour < station.from || (!station.active && hour > station.to)) continue;
      const distance = haversineMeters(lat, lng, station.lat, station.lng);
      if (distance <= this.opts.smhiRadiusM && (!best || distance < best.distance)) best = { station, distance };
    }
    if (!best) return undefined;
    const value = await this.smhiValue(best.station.id, id, hour);
    if (value === undefined) return undefined;
    return { value, at: iso(hour), source: { kind: 'smhi', station: best.station.id, name: best.station.name, distanceM: Math.round(best.distance) } };
  }

  /** The stations measuring a parameter, from a catalogue fetched within `CATALOGUE_MAX_AGE_MS`, or an older one while SMHI is down. */
  private async stations(parameter: number): Promise<SmhiStation[]> {
    const known = this.catalogues.get(parameter);
    if (known) return known;
    const path = smhiCataloguePath(parameter);
    const kept = await this.read<SmhiCatalogue>(path);
    let stations = kept?.stations;
    if (!kept || Date.now() - Date.parse(kept.fetchedAt) > CATALOGUE_MAX_AGE_MS) {
      try {
        this.requests++;
        stations = await fetchSmhiStations(this.opts.smhi, parameter);
        await this.write(path, { parameter, fetchedAt: iso(Date.now()), stations } satisfies SmhiCatalogue);
      } catch (error) {
        if (!stations) throw error;
      }
    }
    this.catalogues.set(parameter, stations!);
    return stations!;
  }

  /** A station's value of a parameter at an hour; undefined where it has none. */
  private async smhiValue(station: number, parameter: number, hour: number): Promise<number | undefined> {
    const year = new Date(hour).getUTCFullYear();
    const path = smhiYearPath(station, parameter, year);
    const lookUp = async (): Promise<{ value?: number } | undefined> => {
      const file = await this.read<SmhiYear>(path);
      if (!file?.covered.some(([from, to]) => from <= hour && hour <= to)) return undefined;
      return { value: file.values[(hour - Date.UTC(year, 0, 1)) / HOUR_MS] ?? undefined };
    };
    const held = await lookUp();
    if (held) return held.value;
    const periods: SmhiPeriod[] = Date.now() - hour < SMHI_RECENT_MS ? ['latest-months'] : ['corrected-archive', 'latest-months'];
    for (const period of periods) {
      const key = `${station}/${parameter}/${period}`;
      if (this.fetched.has(key)) continue;
      this.fetched.add(key);
      this.requests++;
      const series = await fetchSmhiSeries(this.opts.smhi, parameter, station, period);
      if (series) await this.keepSeries(station, parameter, series);
      const found = await lookUp();
      if (found) return found.value;
    }
    return undefined;
  }

  /** Keep a fetched period in the year files it spans, over what they held for those hours. */
  private async keepSeries(station: number, parameter: number, series: SmhiSeries): Promise<void> {
    if (!(series.from <= series.to)) return;
    const lastYear = new Date(series.to).getUTCFullYear();
    for (let year = new Date(series.from).getUTCFullYear(); year <= lastYear; year++) {
      const start = Date.UTC(year, 0, 1);
      const from = Math.max(series.from, start);
      const to = Math.min(series.to, Date.UTC(year + 1, 0, 1) - HOUR_MS);
      const path = smhiYearPath(station, parameter, year);
      const kept = await this.read<SmhiYear>(path);
      const values = kept?.values.slice() ?? [];
      for (let hour = from; hour <= to; hour += HOUR_MS) values[(hour - start) / HOUR_MS] = series.values.get(hour) ?? null;
      for (let i = 0; i < values.length; i++) values[i] ??= null;
      while (values.length && values.at(-1) === null) values.pop();
      const file: SmhiYear = { station, parameter, year, covered: joinSpans([...(kept?.covered ?? []), [from, to]]), values };
      this.files.set(path, file);
      await this.write(path, file);
    }
  }

  /** The parameters Open-Meteo has for a point's cell at an hour. */
  private async fromOpenMeteo(parameters: WeatherParameter[], lat: number, lng: number, hour: number): Promise<Partial<WeatherReading>> {
    if (hour < Date.parse(`${OPEN_METEO_FIRST_DAY}T00:00:00Z`)) return {};
    const cell = cellOf(lat, lng);
    const date = new Date(hour);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const month = iso(start).slice(0, 7);
    const index = (hour - start) / HOUR_MS;
    const path = openMeteoMonthPath(cell.lat, cell.lng, month);
    let file = await this.read<OpenMeteoMonth>(path);
    const lacking = !file || parameters.some((parameter) => typeof file![parameter][index] !== 'number');
    const stale = !file || (Date.parse(file.fetchedAt) < next + OPEN_METEO_SETTLED_MS && Date.now() - Date.parse(file.fetchedAt) >= OPEN_METEO_RETRY_MS);
    if (lacking && stale && !this.fetched.has(path)) {
      this.fetched.add(path);
      this.requests++;
      // The service answers up to today, and refuses a later end.
      const end = iso(Math.min(next - DAY_MS, Date.now())).slice(0, 10);
      file = { ...cell, month, fetchedAt: iso(Date.now()), ...await fetchOpenMeteo(this.opts.openMeteo, cell, `${month}-01`, end) };
      this.files.set(path, file);
      await this.write(path, file);
    }
    const values: Partial<WeatherReading> = {};
    for (const parameter of parameters) {
      const value = file?.[parameter][index];
      if (typeof value === 'number') values[parameter] = { value, at: iso(hour), source: { kind: 'open-meteo', ...cell } };
    }
    return values;
  }

  /** A cache file, read once per lookup. */
  private async read<T>(path: string): Promise<T | undefined> {
    if (!this.files.has(path)) this.files.set(path, await readCache<T>(this.cmd.sys.vfs, this.cmd.access, path));
    return this.files.get(path) as T | undefined;
  }

  /** Keep a file. One that cannot be written, such as by someone who may not write the sources, is asked of the service again next time. */
  private async write(path: string, value: unknown): Promise<void> {
    try {
      await writeCache(this.cmd.sys.vfs, this.cmd.access, path, value);
    } catch {
      // The answer stands without being kept.
    }
  }
}

/** Whether `CFG_WEATHER` lets places and dates be sent to SMHI and Open-Meteo: unless it is `false`, as unset is its default, on. */
export const weatherOn = (settings: Record<string, string | undefined>): boolean => settings.CFG_WEATHER !== 'false';

/**
 * A lookup as the installation's settings say: `CFG_WEATHER_SMHI_KM`, and `SMHI_METOBS_URL` and
 * `OPEN_METEO_ARCHIVE_URL` from the environment. Undefined when `CFG_WEATHER` is off (`weatherOn`).
 */
export const weatherLookupFor = async (cmd: Command): Promise<WeatherLookup | undefined> => {
  const settings = await readSettings(cmd, cmd.access);
  if (!weatherOn(settings)) return undefined;
  const km = parseFloat(settings.CFG_WEATHER_SMHI_KM ?? '');
  return new WeatherLookup(cmd, {
    smhi: cmd.env.SMHI_METOBS_URL || SMHI_METOBS_URL,
    openMeteo: cmd.env.OPEN_METEO_ARCHIVE_URL || OPEN_METEO_ARCHIVE_URL,
    smhiRadiusM: (Number.isFinite(km) ? km : DEFAULT_SMHI_KM) * 1000,
  });
};
