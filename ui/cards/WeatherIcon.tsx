import { type Fall, weatherSky } from '../../lib/weather/kinds.ts';

/** The sun's disc and rays, about (32, 32). */
function Sun() {
  return (
    <g className='wx-sun'>
      <circle cx='32' cy='32' r='10' />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => <line key={angle} x1='32' y1='14' x2='32' y2='8' transform={`rotate(${angle} 32 32)`} />)}
    </g>
  );
}

/** A crescent moon about (32, 32), its bright side to the lower left. */
function Moon() {
  return <path className='wx-moon' d='M38 12 A20 20 0 1 0 52 38 A15 15 0 0 1 38 12 Z' />;
}

/** A cloud resting on y = 46, from x = 13 to 51. */
const CLOUD = 'M20 46 H44 A8.5 8.5 0 0 0 46 29.2 A12.5 12.5 0 0 0 22 27 A9.5 9.5 0 0 0 20 46 Z';

/** What falls, under a cloud lifted to make room: drops as slanted strokes, flakes as dots. */
function Falling({ fall }: { fall: Fall }) {
  const spots = [[23, 46], [32, 49], [41, 46]];
  return (
    <g>
      {spots.map(([x, y], i) => {
        const flake = fall === 'snow' || (fall === 'sleet' && i === 1);
        if (flake) return <circle key={x} className='wx-flake' cx={x - 1} cy={y + 5} r='2.6' />;
        const length = fall === 'drizzle' ? 4 : 9;
        return <line key={x} className={fall === 'drizzle' ? 'wx-drop wx-drizzle' : 'wx-drop'} x1={x} y1={y} x2={x - length / 3} y2={y + length} />;
      })}
    </g>
  );
}

/**
 * A picture of a WMO weather code's weather: the sun, or the moon when `day` is false, cloud, and
 * what falls, lightning or fog, in colours of their own over the text's.
 */
export function WeatherIcon({ code, day = true, size = '1em' }: { code: number; day?: boolean; size?: number | string }) {
  const sky = weatherSky(code);
  const lifted = sky.fall || sky.lightning || sky.fog;
  const Light = day ? Sun : Moon;
  return (
    <svg viewBox='0 0 64 64' width={size} height={size} aria-hidden className='wx-icon' style={{ flex: 'none' }}>
      {sky.light === 'clear' && <Light />}
      {sky.light === 'behind' && (
        <g transform='translate(4 1) scale(0.66)'>
          <Light />
        </g>
      )}
      {sky.cloud && (
        <path
          className={sky.light === 'none' && (sky.fall || sky.lightning) ? 'wx-cloud wx-cloud-dark' : 'wx-cloud'}
          d={CLOUD}
          transform={lifted ? 'translate(0 -10)' : sky.light === 'behind' ? 'translate(4 2)' : undefined}
        />
      )}
      {sky.lightning && <path className='wx-bolt' d='M33 34 L26 47 H32 L29 58 L39 43 H33 L36 34 Z' />}
      {sky.fall && !sky.lightning && <Falling fall={sky.fall} />}
      {sky.fog && (
        <g className='wx-fog'>
          <line x1='14' y1='44' x2='50' y2='44' />
          <line x1='18' y1='51' x2='46' y2='51' />
        </g>
      )}
    </svg>
  );
}
