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

/**
 * The kind of weather, as the WMO code the forecast gives it: 0 clear, 1–3 mainly clear to
 * overcast, 45 and 48 fog, 51–57 drizzle, 61–67 rain, 71–77 snow, 80–82 rain showers, 85 and 86
 * snow showers, 95–99 thunderstorm.
 */
type WeatherCode = number;

/** `weather-forecast`: the weather at a place now, as the forecast has it. */
export type WeatherNow = {
  /** The quarter hour it holds for, ISO in UTC. */
  time: string;
  code: WeatherCode;
  /** Whether the sun is up. */
  isDay: boolean;
  /** Air temperature, °C. */
  temperature: number;
  /** What the temperature feels like with the wind and the damp, °C. */
  feelsLike: number;
  /** Rain and snow over the quarter hour, mm. */
  precipitation: number;
  /** Mean wind speed and gusts, m/s. */
  windSpeed: number;
  windGusts: number;
  /** Where the wind blows from, degrees clockwise from north. */
  windDirection: number;
  /** Total cloud cover, percent. */
  cloudCover: number;
};

/** `weather-forecast`: one hour ahead. */
export type ForecastHour = {
  /** The hour's start, ISO in UTC. */
  time: string;
  code: WeatherCode;
  isDay: boolean;
  temperature: number;
  /** Rain and snow over the hour, mm, and the chance of any, percent. */
  precipitation: number;
  precipitationChance?: number;
  windSpeed: number;
  windDirection: number;
};

/** `weather-forecast`: one day ahead, by the place's own calendar. */
export type ForecastDay = {
  /** `YYYY-MM-DD` in the place's time zone. */
  date: string;
  /** The day's most significant weather. */
  code: WeatherCode;
  temperatureMin: number;
  temperatureMax: number;
  /** Rain and snow over the day, mm, and the highest chance of any in an hour of it, percent. */
  precipitation: number;
  precipitationChance?: number;
  /** The strongest mean wind, m/s, and the direction it mostly blows from. */
  windSpeedMax: number;
  windDirection: number;
  /** ISO in UTC; left out where the sun does not rise or set that day. */
  sunrise?: string;
  sunset?: string;
};

/**
 * `weather-forecast`: the weather at a place now, the next hours from the one under way, and the
 * days ahead from today, from Open-Meteo's forecast.
 */
export type WeatherForecast = {
  lat: number;
  lng: number;
  /** The place as the search found it, when it was asked for by name. */
  place?: string;
  /** The place's time zone, such as `Europe/Stockholm`, whose calendar the days follow. */
  timezone: string;
  /** When the forecast was fetched, ISO in UTC. */
  fetchedAt: string;
  now: WeatherNow;
  hours: ForecastHour[];
  days: ForecastDay[];
};
