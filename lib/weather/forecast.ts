/**
 * Open-Meteo's forecast API: the weather at a place now and for up to 16 days ahead, from the best
 * of the national weather models for the place (`@archive/weather/forecast`).
 *
 * The service is free for non-commercial use and needs no key. A forecast is kept in memory for
 * `KEPT_MS`, so the many screens showing one dashboard card ask once between them.
 */
import type { ForecastDay, ForecastHour, WeatherForecast, WeatherNow } from '@archive/weather/api';
import { weatherFetch } from '@archive/weather/fetch';
import { nominatimSearch } from '@archive/location/geocode';

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** The days the service forecasts at most, today included. */
export const MAX_FORECAST_DAYS = 16;

/** How long a forecast is answered from memory: the service's models run hourly at the most. */
const KEPT_MS = 10 * 60_000;

const CURRENT = 'temperature_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const HOURLY = 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day';
const DAILY =
  'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset';

/** The places found by name, by the search's URL and the name: a place stays where it is. */
const places = new Map<string, { lat: number; lng: number; name: string }>();

/**
 * The first hit of a Nominatim search for a place's name, null when there is none. A place found
 * is asked for once; a name that found none is asked again next time. Throws when the search fails.
 */
export const placeNamed = async (name: string, baseUrl?: string): Promise<{ lat: number; lng: number; name: string } | null> => {
  const key = `${baseUrl ?? ''}\n${name}`;
  const known = places.get(key);
  if (known) return known;
  const [found] = await nominatimSearch(name, { limit: 1, baseUrl });
  if (!found?.lat || !found.lon) return null;
  const place = { lat: Number(found.lat), lng: Number(found.lon), name: found.display_name ?? name };
  places.set(key, place);
  return place;
};

/** The forecasts fetched lately, by URL. */
const kept = new Map<string, { at: number; forecast: Omit<WeatherForecast, 'place'> }>();

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

type Columns = Record<string, unknown[] | undefined>;

/** Column `name`'s value at `i` when it is a number. */
const numberAt = (columns: Columns | undefined, name: string, i: number): number | undefined => {
  const value = columns?.[name]?.[i];
  return typeof value === 'number' ? value : undefined;
};

/** Column `name`'s value at `i`, 0 where the service has none. */
const valueAt = (columns: Columns | undefined, name: string, i: number): number => numberAt(columns, name, i) ?? 0;

/** A day's sunrise and sunset, those it has. */
const sunTimes = (sunrise: number | undefined, sunset: number | undefined): Pick<ForecastDay, 'sunrise' | 'sunset'> => ({
  ...(sunrise !== undefined ? { sunrise: iso(sunrise) } : {}),
  ...(sunset !== undefined ? { sunset: iso(sunset) } : {}),
});

/**
 * The forecast for a point: the weather now, `hours` hours from the one under way, and `days` days
 * from today in the place's time zone. Throws when the service fails.
 */
export const fetchForecast = async (base: string, lat: number, lng: number, days: number, hours: number): Promise<Omit<WeatherForecast, 'place'>> => {
  const url = new URL(base);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('current', CURRENT);
  url.searchParams.set('hourly', HOURLY);
  url.searchParams.set('daily', DAILY);
  // Enough days for the hours asked for, which may reach past the last day shown.
  url.searchParams.set('forecast_days', String(Math.min(MAX_FORECAST_DAYS, Math.max(days, Math.ceil(hours / 24) + 1))));
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('timeformat', 'unixtime');
  const key = url.href;
  const known = kept.get(key);
  if (known && Date.now() - known.at < KEPT_MS) return trim(known.forecast, days, hours);

  const response = await weatherFetch(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url.host} returned ${response.status}`);
  }
  const answer = await response.json() as {
    timezone?: string;
    utc_offset_seconds?: number;
    current?: Record<string, unknown>;
    hourly?: Columns;
    daily?: Columns;
  };
  const current = answer.current;
  if (!current || typeof current.time !== 'number') throw new Error(`${url.host} answered no current weather`);
  const at = (name: string): number => typeof current[name] === 'number' ? current[name] as number : 0;
  const now: WeatherNow = {
    time: iso(current.time),
    code: at('weather_code'),
    isDay: at('is_day') === 1,
    temperature: at('temperature_2m'),
    feelsLike: at('apparent_temperature'),
    precipitation: at('precipitation'),
    windSpeed: at('wind_speed_10m'),
    windGusts: at('wind_gusts_10m'),
    windDirection: at('wind_direction_10m'),
    cloudCover: at('cloud_cover'),
  };

  const { hourly, daily } = answer;
  const forecastHours: ForecastHour[] = (hourly?.time ?? []).flatMap((time, i) =>
    typeof time === 'number'
      ? [{
        time: iso(time),
        code: valueAt(hourly, 'weather_code', i),
        isDay: valueAt(hourly, 'is_day', i) === 1,
        temperature: valueAt(hourly, 'temperature_2m', i),
        precipitation: valueAt(hourly, 'precipitation', i),
        precipitationChance: numberAt(hourly, 'precipitation_probability', i),
        windSpeed: valueAt(hourly, 'wind_speed_10m', i),
        windDirection: valueAt(hourly, 'wind_direction_10m', i),
      }]
      : []
  );
  // A day's time is its midnight in the place's time zone. The offset is today's: read at noon, a
  // day across a change of summer time still falls on its own date.
  const offset = answer.utc_offset_seconds ?? 0;
  const forecastDays: ForecastDay[] = (daily?.time ?? []).flatMap((time, i) => {
    if (typeof time !== 'number') return [];
    return [{
      date: iso(time + offset + 12 * 3600).slice(0, 10),
      code: valueAt(daily, 'weather_code', i),
      temperatureMin: valueAt(daily, 'temperature_2m_min', i),
      temperatureMax: valueAt(daily, 'temperature_2m_max', i),
      precipitation: valueAt(daily, 'precipitation_sum', i),
      precipitationChance: numberAt(daily, 'precipitation_probability_max', i),
      windSpeedMax: valueAt(daily, 'wind_speed_10m_max', i),
      windDirection: valueAt(daily, 'wind_direction_10m_dominant', i),
      ...sunTimes(numberAt(daily, 'sunrise', i), numberAt(daily, 'sunset', i)),
    }];
  });

  const forecast = { lat, lng, timezone: answer.timezone ?? 'GMT', fetchedAt: new Date().toISOString(), now, hours: forecastHours, days: forecastDays };
  for (const [url, entry] of kept) if (Date.now() - entry.at >= KEPT_MS) kept.delete(url);
  kept.set(key, { at: Date.now(), forecast });
  return trim(forecast, days, hours);
};

/** A forecast cut to `hours` hours from the one under way now, and to `days` days. */
const trim = (forecast: Omit<WeatherForecast, 'place'>, days: number, hours: number): Omit<WeatherForecast, 'place'> => {
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  return {
    ...forecast,
    hours: forecast.hours.filter((each) => Date.parse(each.time) >= hour).slice(0, hours),
    days: forecast.days.slice(0, days),
  };
};
