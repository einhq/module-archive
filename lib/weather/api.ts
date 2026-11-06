/**
 * What the weather area's commands answer with under `JSON_OUTPUT=1`, as types (`@archive/weather/api`).
 *
 * Import-free, so a browser and other modules can import it without type-checking the module.
 */

/**
 * Where one value came from: an SMHI station's observation, with how far the station is from the
 * place, or the ERA5 reanalysis Open-Meteo serves for the 0.25° cell around it.
 */
type WeatherSource =
  | { kind: 'smhi'; station: number; name: string; distanceM: number }
  | { kind: 'open-meteo'; lat: number; lng: number };

/** One parameter's value, the hour it holds for (ISO, UTC) and where it came from. */
export type WeatherValue = { value: number; at: string; source: WeatherSource };

/** The parameters a reading carries. */
export type WeatherParameter = 'temperature' | 'windSpeed' | 'windDirection' | 'cloudCover';

/**
 * `weather`: the weather at a place and time, from the hour nearest it. A parameter neither source
 * has for that hour is left out, and so is every one for a time still to come.
 */
export type WeatherReading = {
  lat: number;
  lng: number;
  /** The time asked about, ISO in UTC. */
  time: string;
  /** Air temperature, °C. */
  temperature?: WeatherValue;
  /** Mean wind speed, m/s. */
  windSpeed?: WeatherValue;
  /** Where the wind blows from, degrees clockwise from north. */
  windDirection?: WeatherValue;
  /** Total cloud cover, percent. */
  cloudCover?: WeatherValue;
};

/**
 * `weather-photo`: the weather it wrote on a photo's position, or why it wrote none. `off` is
 * `CFG_WEATHER` turned off; `current` a position whose weather is for its point and capture time
 * already; `no point` and `no time` a photo with nothing to look up yet. A photo whose capture time
 * went away loses its weather (`removed`).
 */
export type WeatherPhotoResult =
  | { position: string; weather: WeatherReading; requests: number }
  | { position: string; skipped: 'off' | 'current' | 'no point' | 'no time'; removed?: true };
