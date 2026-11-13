import { Skeleton, Stack, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import type { CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ForecastDay, WeatherForecast } from '../../lib/weather/api.ts';
import { weatherWords } from '../../lib/weather/kinds.ts';
import { compassPoint } from '../location/lib/weather.ts';
import { WeatherIcon } from './WeatherIcon.tsx';
import './weather.css';

/** A place given as coordinates, `57.71, 11.97`, rather than by name. */
const COORDINATES = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** How a place is asked for: by its coordinates when it is given as two numbers, by name otherwise. */
const placeArgs = (place: string): string => {
  const match = place.match(COORDINATES);
  return match ? `--lat=${match[1]} --lng=${match[2]}` : `--place=${shq(place)}`;
};

/** A temperature in whole degrees with a minus sign, never `-0`. */
const degrees = (value: number): string => `${(Math.round(value) || 0).toString().replace('-', '\u2212')}°`;

/** Rain and snow in millimetres, to a tenth below ten. */
const millimetres = (value: number): string => (value < 10 ? value.toFixed(1) : Math.round(value).toString());

/** The heights, in the card's em, of what it draws, with the gaps above them: worked out ahead so that only what fits is drawn. */
const PLACE_EM = 1.15 + 0.9;
const NOW_EM = 3.6;
const HOURS_EM = 6.1 + 0.9;
const DAY_EM = 2.1;
/** The width, in em, of one hour of the hours row. */
const HOUR_EM = 3.1;

/** The text size for a card of this size: larger as the card is, within reason. */
const textSize = (width: number, height: number): number => Math.max(13, Math.min(30, Math.min(width, height) * 0.055));

/**
 * What a card of this size has room for: the hours row, and whether the days go beside the rest or
 * under it. How many days fit is measured once they are laid out (`Days`).
 */
const layoutFor = (width: number, height: number, size: number) => {
  const wide = width / size - 2;
  const high = height / size - 1.6;
  const side = wide >= 30 && width >= 1.45 * height;
  const column = side ? (wide - 2.4) / 2 : wide;
  const nowEm = PLACE_EM + (column >= 18 ? NOW_EM : NOW_EM + 2.6);
  const hours = column >= 13 && high >= nowEm + HOURS_EM ? Math.min(12, Math.floor(column / HOUR_EM)) : 0;
  return { side, hours, under: !side && high - nowEm - (hours ? HOURS_EM : 0) >= DAY_EM + 1 };
};

/**
 * The days ahead as rows, as many as the room left has height for: the day, its weather, and its
 * lowest and highest temperature on a bar spanning all the days shown.
 */
function Days({ forecast, size }: { forecast: WeatherForecast; size: number }) {
  const { ref, height } = useElementSize();
  const days = forecast.days.slice(0, Math.floor(height / (DAY_EM * size)));
  return (
    <div ref={ref} className='wx-days' data-empty={days.length === 0 || undefined}>
      {days.length > 0 && <DayRows days={days} zone={forecast.timezone} />}
    </div>
  );
}

function DayRows({ days, zone }: { days: ForecastDay[]; zone: string }) {
  const low = Math.min(...days.map((day) => day.temperatureMin));
  const high = Math.max(...days.map((day) => day.temperatureMax));
  const span = high - low || 1;
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  return (
    <>
      {days.map((day) => (
        <div key={day.date} className='wx-day' title={weatherWords(day.code)}>
          <span style={{ textTransform: 'capitalize' }}>{day.date === today ? 'Today' : weekday.format(new Date(`${day.date}T12:00:00Z`))}</span>
          <WeatherIcon code={day.code} size='1.7em' />
          <span>{degrees(day.temperatureMin)}</span>
          <div className='wx-range'>
            <span style={{ left: `${((day.temperatureMin - low) / span) * 100}%`, right: `${((high - day.temperatureMax) / span) * 100}%` }} />
          </div>
          <span>{degrees(day.temperatureMax)}</span>
          <span className='wx-wet'>{day.precipitation >= 0.1 ? `${millimetres(day.precipitation)} mm` : ''}</span>
        </div>
      ))}
    </>
  );
}

/**
 * `/cards/archive/weather`: the weather at a place (`place`, by name or as `lat, lng`) now — its
 * picture, the temperature, what it feels like, the wind — and, as the card has room, the next
 * hours in a row under it and up to `days` days ahead, under it or beside it on a wide card. Hours
 * and days are the place's own. Read every fifteen minutes.
 */
export default function WeatherCard() {
  const [params] = useSearchParams();
  const place = (params.get('place') ?? '').trim();
  const label = params.get('label') || place;
  const days = Math.min(10, Number(params.get('days') ?? 5) || 5);
  const forecast = usePolledCommand<WeatherForecast>(`weather-forecast ${placeArgs(place)} --days=${days} --hours=24`, place !== '', 15 * 60_000);
  const { ref, width, height } = useElementSize();
  const size = textSize(width, height);

  return (
    <div ref={ref} className='wx' style={{ fontSize: size } as CSSProperties}>
      {!place
        ? <Quiet>Choose a place to show the weather of</Quiet>
        : forecast.data
        ? width > 0 && <Forecast forecast={forecast.data} label={label} width={width} height={height} size={size} />
        : forecast.error
        ? <Quiet>{forecast.error.message.replace(/^weather-forecast: /, '')}</Quiet>
        : <Skeleton height='70%' radius='md' />}
    </div>
  );
}

/** The forecast drawn to the card's size: the weather now, and the hours and days it has room for. */
function Forecast({ forecast, label, width, height, size }: { forecast: WeatherForecast; label: string; width: number; height: number; size: number }) {
  const { now, timezone } = forecast;
  const fit = layoutFor(width, height, size);
  const hourOf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', timeZone: timezone });
  const clockOf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: timezone });
  const today = forecast.days[0];

  return (
    <>
      <div className='wx-side'>
        <div className='wx-place'>{label}</div>
        <div className='wx-now' style={{ flexWrap: fit.side || width / size >= 20 ? 'nowrap' : 'wrap' }}>
          <WeatherIcon code={now.code} day={now.isDay} size={`${NOW_EM}em`} />
          <div className='wx-temp'>{degrees(now.temperature)}</div>
          <Stack gap='0.25em' style={{ minWidth: 0, flex: '1 1 8em', marginLeft: '0.4em' }}>
            <div className='wx-words'>{weatherWords(now.code)}</div>
            <div className='wx-detail'>
              <span>Feels like {degrees(now.feelsLike)}</span>
              <span>
                <TablerIcon name='arrow-up' size='1em' style={{ transform: `rotate(${now.windDirection + 180}deg)` }} />
                {Math.round(now.windSpeed)} ({Math.round(now.windGusts)}) m/s {compassPoint(now.windDirection)}
              </span>
              {today?.sunrise && today.sunset && width / size >= 26 && (
                <span>
                  <TablerIcon name='sunrise' size='1.1em' /> {clockOf.format(new Date(today.sunrise))}
                  <TablerIcon name='sunset' size='1.1em' style={{ marginLeft: '0.3em' }} /> {clockOf.format(new Date(today.sunset))}
                </span>
              )}
            </div>
          </Stack>
        </div>
        {fit.hours > 0 && (
          <div className='wx-hours'>
            {forecast.hours.slice(0, fit.hours).map((hour, i) => (
              <div key={hour.time} className='wx-hour' title={weatherWords(hour.code)}>
                <span className='wx-small'>{i === 0 ? 'Now' : hourOf.format(new Date(hour.time))}</span>
                <WeatherIcon code={hour.code} day={hour.isDay} size='1.8em' />
                <span>{degrees(hour.temperature)}</span>
                <span className='wx-wet'>{hour.precipitation >= 0.1 ? millimetres(hour.precipitation) : ' '}</span>
              </div>
            ))}
          </div>
        )}
        {fit.under && <Days forecast={forecast} size={size} />}
      </div>
      {fit.side && <Days forecast={forecast} size={size} />}
    </>
  );
}

/** What the card says in place of the weather, quiet, in the middle. */
function Quiet({ children }: { children: string }) {
  return (
    <Stack h='100%' align='center' justify='center' gap={6} c='dimmed' p='md' ta='center'>
      <TablerIcon name='cloud-off' size={26} stroke={1.5} />
      <Text size='sm' maw={260}>{children}</Text>
    </Stack>
  );
}
