/**
 * The weather of a track's trips and their legs (`@archive/location/trip-weather`), as
 * `track-weather` gives it them: the track is sampled once an hour, the weather looked up where the
 * track was at each of those hours, and the hours summed up for each leg and for the whole trip.
 */

import type { Trip, TripLeg, TripWeather } from '@archive/location/api';
import type { WeatherReading } from '@archive/weather/api';

const HOUR_MS = 3_600_000;

/** A fix of the track: its time (epoch ms) and where it was. */
export type WeatherFix = { ms: number; lat: number; lng: number };

/**
 * One fix for each whole hour from `start` to `end` (epoch ms), the one nearest that hour, with the
 * hour as its time. A span within one hour gets the hour nearest its middle. `fixes` are sorted by
 * time; none gives no hours.
 */
export const hourlyFixes = (fixes: WeatherFix[], start: number, end: number): WeatherFix[] => {
  if (fixes.length === 0) return [];
  const first = Math.ceil(start / HOUR_MS) * HOUR_MS;
  const hours = first <= end
    ? Array.from({ length: Math.floor((end - first) / HOUR_MS) + 1 }, (_, i) => first + i * HOUR_MS)
    : [Math.round((start + end) / 2 / HOUR_MS) * HOUR_MS];
  const sampled: WeatherFix[] = [];
  let i = 0;
  for (const hour of hours) {
    while (i + 1 < fixes.length && Math.abs(fixes[i + 1].ms - hour) <= Math.abs(fixes[i].ms - hour)) i++;
    sampled.push({ ms: hour, lat: fixes[i].lat, lng: fixes[i].lng });
  }
  return sampled;
};

const round = (value: number, digits: number): number => Number(value.toFixed(digits));
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The weather over the hours read: mean wind speed and the strongest hour's, where the wind blew
 * from as the mean of the directions taken as vectors (so 350° and 10° make north), the coldest and
 * the warmest hour, and the mean cloud cover; speeds and temperatures to a tenth.
 */
export const summarizeWeather = (readings: WeatherReading[]): TripWeather => {
  const values = (parameter: 'temperature' | 'windSpeed' | 'windDirection' | 'cloudCover') =>
    readings.flatMap((reading) => reading[parameter] ? [reading[parameter]!.value] : []);
  const speeds = values('windSpeed');
  const directions = values('windDirection');
  const temperatures = values('temperature');
  const clouds = values('cloudCover');
  const summary: TripWeather = { hours: readings.length };
  if (speeds.length) Object.assign(summary, { windSpeed: round(mean(speeds), 1), windMax: round(Math.max(...speeds), 1) });
  if (directions.length) {
    const radians = directions.map((degrees) => (degrees * Math.PI) / 180);
    const x = mean(radians.map(Math.sin));
    const y = mean(radians.map(Math.cos));
    if (x !== 0 || y !== 0) summary.windDirection = Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360) % 360;
  }
  if (temperatures.length) Object.assign(summary, { temperatureMin: round(Math.min(...temperatures), 1), temperatureMax: round(Math.max(...temperatures), 1) });
  if (clouds.length) summary.cloudCover = Math.round(mean(clouds));
  return summary;
};

const spanKey = (span: { start: string; end: string }): string => `${span.start}/${span.end}`;

/**
 * `trips` with the weather `held` gave the same trips and legs: a leg keeps its weather while it
 * starts and ends where it did, and a trip while it does and its legs all keep theirs.
 */
export const keepTripWeather = (trips: Trip[], held: Trip[]): Trip[] => {
  const legs = new Map(held.flatMap((trip) => trip.legs.flatMap((leg) => leg.weather ? [[spanKey(leg), leg.weather] as const] : [])));
  const whole = new Map(held.flatMap((trip) => trip.weather ? [[spanKey(trip), trip.weather] as const] : []));
  return trips.map((trip) => {
    const kept = trip.legs.map((leg): TripLeg => {
      const { weather: _weather, ...rest } = leg;
      const weather = legs.get(spanKey(leg));
      return weather ? { ...rest, weather } : rest;
    });
    const { weather: _weather, ...rest } = trip;
    const weather = whole.get(spanKey(trip));
    return weather && kept.every((leg) => leg.weather) ? { ...rest, legs: kept, weather } : { ...rest, legs: kept };
  });
};
