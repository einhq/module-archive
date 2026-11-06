/**
 * The weather a photo was taken in (`@archive/weather/photo`): `weather-photo` writes it on the
 * file's `position` child as `weather`, the `WeatherReading` of the photo's point and capture time
 * (`takenAtUtc` on the file).
 */
import type { WeatherReading } from '@archive/weather/api';

/** The attr on a file's `position` child that holds the weather the photo was taken in. */
export const PHOTO_WEATHER_ATTR = 'weather';

/** The capture time a file's attrs give, ms; undefined for a file with none. */
export const captureTime = (fileAttrs: Record<string, unknown>): number | undefined => {
  const time = typeof fileAttrs.takenAtUtc === 'string' ? Date.parse(fileAttrs.takenAtUtc) : NaN;
  return Number.isNaN(time) ? undefined : time;
};

/**
 * Whether a photo is owed its weather: it has a capture time, and its position holds no weather,
 * or weather read for another time. A point moved is not seen here, from attrs alone; writing the
 * point is a fact of its own, which `media-weather` takes.
 */
export const weatherOwed = (fileAttrs: Record<string, unknown>, positionAttrs: Record<string, unknown>): boolean => {
  const time = captureTime(fileAttrs);
  if (time === undefined) return false;
  const held = positionAttrs[PHOTO_WEATHER_ATTR] as Partial<WeatherReading> | undefined;
  return typeof held?.time !== 'string' || Date.parse(held.time) !== time;
};
