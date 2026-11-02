/**
 * The weather that has been looked up, kept as JSON files under `/archive/sources/weather/`, so a
 * place and time is asked of a service once (`@archive/weather/cache`):
 *
 * - `smhi/stations-<parameter>.json`: SMHI's catalogue of the stations measuring a parameter.
 * - `smhi/<station>/<parameter>/<YYYY>.json`: a station's hourly values of a parameter in a year.
 * - `open-meteo/<lat>_<lng>/<YYYY-MM>.json`: a 0.25° cell's hourly values in a month.
 *
 * Everything here can be asked again, so the files are on the volatile tier: a station's history
 * is decades of hours.
 */
import type { Command } from '@ein/client';
import { SOURCES_ROOT } from '@archive/paths';
import { ensureFolder } from '@archive/sources';
import type { SmhiStation } from '@archive/weather/smhi';
import type { OpenMeteoHours } from '@archive/weather/open-meteo';
import { basename, dirname } from '@std/path';
import { toText } from '@std/streams';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

const WEATHER_CACHE = `${SOURCES_ROOT}/weather`;

/** SMHI's catalogue of the stations measuring a parameter, and when it was fetched (ISO). */
export type SmhiCatalogue = { parameter: number; fetchedAt: string; stations: SmhiStation[] };

/** A station's values of one parameter in one year. */
export type SmhiYear = {
  station: number;
  parameter: number;
  year: number;
  /**
   * The spans of hours (ms, inclusive) the station's files have been read for, in order. An hour
   * inside one with no value was not observed; one outside them has not been asked.
   */
  covered: [number, number][];
  /** By the hour from the year's first, null where there is no value. */
  values: (number | null)[];
};

/** A 0.25° cell's hourly values in one month, by the hour from the month's first, and when they were fetched (ISO). */
export type OpenMeteoMonth = { lat: number; lng: number; month: string; fetchedAt: string } & OpenMeteoHours;

export const smhiCataloguePath = (parameter: number): string => `${WEATHER_CACHE}/smhi/stations-${parameter}.json`;

export const smhiYearPath = (station: number, parameter: number, year: number): string => `${WEATHER_CACHE}/smhi/${station}/${parameter}/${year}.json`;

export const openMeteoMonthPath = (lat: number, lng: number, month: string): string => `${WEATHER_CACHE}/open-meteo/${lat.toFixed(2)}_${lng.toFixed(2)}/${month}.json`;

/** A cache file's content, or undefined when there is none or it cannot be read. */
export const readCache = async <T>(vfs: Vfs, access: Access, path: string): Promise<T | undefined> => {
  try {
    if (!await vfs.exists(access, path)) return undefined;
    const handle = await vfs.open(access, path, { mode: 'r' });
    try {
      return JSON.parse(await toText(handle.readable)) as T;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return undefined;
  }
};

/**
 * Write a cache file, made with its folders when missing. Whoever looks the weather up writes it:
 * the folders take `/archive/sources`'s group, so the next person can write them too.
 */
export const writeCache = async (vfs: Vfs, access: Access, path: string, value: unknown): Promise<void> => {
  const folder = dirname(path);
  await ensureFolder(vfs, access, folder);
  await vfs.ensure(access, 'file', folder, basename(path), { props: { tier: 'volatile' }, attrs: { mimetype: 'application/json' } });
  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(JSON.stringify(value)));
  } finally {
    await handle.close();
  }
};
