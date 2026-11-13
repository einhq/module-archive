/**
 * The kind of weather a WMO code stands for, in words and as what a picture of it holds
 * (`@archive/weather/kinds`). Import-free, so the card in the browser reads codes as the command does.
 */

/** What falls from the sky. */
export type Fall = 'drizzle' | 'rain' | 'sleet' | 'snow';

/** What a picture of the weather holds: the sun or moon, cloud, what falls, lightning, fog. */
type Sky = {
  /** The sun or moon shows: all of it under a clear sky, behind a cloud when partly cloudy. */
  light: 'clear' | 'behind' | 'none';
  cloud: boolean;
  fall?: Fall;
  lightning?: boolean;
  fog?: boolean;
};

/** Each code's words and picture, by the code. */
const KINDS: Record<number, [string, Sky]> = {
  0: ['Clear', { light: 'clear', cloud: false }],
  1: ['Mainly clear', { light: 'clear', cloud: false }],
  2: ['Partly cloudy', { light: 'behind', cloud: true }],
  3: ['Overcast', { light: 'none', cloud: true }],
  45: ['Fog', { light: 'none', cloud: true, fog: true }],
  48: ['Freezing fog', { light: 'none', cloud: true, fog: true }],
  51: ['Light drizzle', { light: 'none', cloud: true, fall: 'drizzle' }],
  53: ['Drizzle', { light: 'none', cloud: true, fall: 'drizzle' }],
  55: ['Heavy drizzle', { light: 'none', cloud: true, fall: 'drizzle' }],
  56: ['Freezing drizzle', { light: 'none', cloud: true, fall: 'sleet' }],
  57: ['Freezing drizzle', { light: 'none', cloud: true, fall: 'sleet' }],
  61: ['Light rain', { light: 'none', cloud: true, fall: 'rain' }],
  63: ['Rain', { light: 'none', cloud: true, fall: 'rain' }],
  65: ['Heavy rain', { light: 'none', cloud: true, fall: 'rain' }],
  66: ['Freezing rain', { light: 'none', cloud: true, fall: 'sleet' }],
  67: ['Freezing rain', { light: 'none', cloud: true, fall: 'sleet' }],
  71: ['Light snow', { light: 'none', cloud: true, fall: 'snow' }],
  73: ['Snow', { light: 'none', cloud: true, fall: 'snow' }],
  75: ['Heavy snow', { light: 'none', cloud: true, fall: 'snow' }],
  77: ['Snow grains', { light: 'none', cloud: true, fall: 'snow' }],
  80: ['Light showers', { light: 'behind', cloud: true, fall: 'rain' }],
  81: ['Showers', { light: 'behind', cloud: true, fall: 'rain' }],
  82: ['Heavy showers', { light: 'none', cloud: true, fall: 'rain' }],
  85: ['Snow showers', { light: 'behind', cloud: true, fall: 'snow' }],
  86: ['Heavy snow showers', { light: 'none', cloud: true, fall: 'snow' }],
  95: ['Thunderstorm', { light: 'none', cloud: true, fall: 'rain', lightning: true }],
  96: ['Thunderstorm with hail', { light: 'none', cloud: true, fall: 'sleet', lightning: true }],
  99: ['Thunderstorm with hail', { light: 'none', cloud: true, fall: 'sleet', lightning: true }],
};

/** The weather of a WMO code in words, such as `Light rain`. */
export const weatherWords = (code: number): string => KINDS[code]?.[0] ?? `Weather code ${code}`;

/** What a picture of a WMO code's weather holds; a code it does not know is a cloud. */
export const weatherSky = (code: number): Sky => KINDS[code]?.[1] ?? { light: 'none', cloud: true };
