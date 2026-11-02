/**
 * Open-Meteo's historical weather API: the hourly ERA5 reanalysis for any place on earth, from
 * 1940 until a few days ago, with forecasts filling the last days (`@archive/weather/open-meteo`).
 *
 * The service is free for non-commercial use and needs no key. ERA5's grid is 0.25°, so the
 * weather is asked for the cell a place is in (`cellOf`), a month at a time.
 */
import type { WeatherParameter } from '@archive/weather/api';
import { weatherFetch } from '@archive/weather/fetch';

export const OPEN_METEO_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** The first day the service has. */
export const OPEN_METEO_FIRST_DAY = '1940-01-01';

/** Open-Meteo's name of each parameter. */
const VARIABLES: Record<WeatherParameter, string> = {
  temperature: 'temperature_2m',
  windSpeed: 'wind_speed_10m',
  windDirection: 'wind_direction_10m',
  cloudCover: 'cloud_cover',
};

/** The centre of the 0.25° cell a point is in. */
export const cellOf = (lat: number, lng: number): { lat: number; lng: number } => ({ lat: Math.round(lat * 4) / 4, lng: Math.round(lng * 4) / 4 });

/** A cell's hourly values from its first hour asked for, in order; null where the service has none. */
export type OpenMeteoHours = Record<WeatherParameter, (number | null)[]>;

/** A cell's hourly values over the days `start` to `end` (`YYYY-MM-DD`, UTC, inclusive). */
export const fetchOpenMeteo = async (base: string, cell: { lat: number; lng: number }, start: string, end: string): Promise<OpenMeteoHours> => {
  const url = new URL(base);
  url.searchParams.set('latitude', String(cell.lat));
  url.searchParams.set('longitude', String(cell.lng));
  url.searchParams.set('start_date', start);
  url.searchParams.set('end_date', end);
  url.searchParams.set('hourly', Object.values(VARIABLES).join(','));
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone', 'GMT');
  const response = await weatherFetch(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url.host} returned ${response.status}`);
  }
  const answer = await response.json() as { hourly?: Record<string, unknown> };
  const column = (name: string): (number | null)[] => {
    const values = answer.hourly?.[name];
    return Array.isArray(values) ? values.map((value) => typeof value === 'number' ? value : null) : [];
  };
  return {
    temperature: column(VARIABLES.temperature),
    windSpeed: column(VARIABLES.windSpeed),
    windDirection: column(VARIABLES.windDirection),
    cloudCover: column(VARIABLES.cloudCover),
  };
};
