/** How the weather reads in the archive's pages. */
import type { WeatherReading } from '@archive/weather/api';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** The compass point nearest a direction, degrees clockwise from north. */
export const compassPoint = (degrees: number): string => COMPASS[Math.round(degrees / 45) % 8];

export const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** The weather of an hour in a line: temperature, wind and cloud cover, those it has. */
export const readingLine = (reading: WeatherReading): string | undefined => {
  const parts: string[] = [];
  if (reading.temperature) parts.push(`${oneDecimal.format(reading.temperature.value)} °C`);
  if (reading.windSpeed) {
    parts.push(`Wind ${oneDecimal.format(reading.windSpeed.value)} m/s` + (reading.windDirection ? `, from ${compassPoint(reading.windDirection.value)}` : ''));
  }
  if (reading.cloudCover) parts.push(`${Math.round(reading.cloudCover.value)} % cloud`);
  return parts.length ? parts.join(' · ') : undefined;
};

/** Where an hour's weather came from: each station, or Open-Meteo, once. */
export const readingSources = (reading: WeatherReading): string => {
  const names = new Set<string>();
  for (const value of [reading.temperature, reading.windSpeed, reading.windDirection, reading.cloudCover]) {
    if (value) names.add(value.source.kind === 'smhi' ? `SMHI ${value.source.name}` : 'Open-Meteo');
  }
  return [...names].join(', ');
};
