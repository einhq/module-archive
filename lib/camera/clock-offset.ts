/**
 * How far a camera's clock was off, as `camera-update --clock-offset` and the **Edit** dialog take
 * it: a signed sum of days, hours, minutes and seconds (`+23h 2m`, `-5m`, `1d`, `0`), positive when
 * the clock ran ahead. Import-free, so a browser can import it.
 */

const UNITS = [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]] as const;

/** Seconds, or undefined when the text is not a clock offset. */
export const parseClockOffset = (text: string): number | undefined => {
  const trimmed = text.trim().replace(/^−/, '-');
  if (/^[-+]?0$/.test(trimmed)) return 0;
  const match = /^([-+]?)\s*((?:\d+\s*[dhms]\s*)+)$/.exec(trimmed);
  if (!match) return undefined;
  const seen = new Set<string>();
  let seconds = 0;
  for (const [, count, unit] of match[2].matchAll(/(\d+)\s*([dhms])/g)) {
    if (seen.has(unit)) return undefined;
    seen.add(unit);
    seconds += Number(count) * UNITS.find(([name]) => name === unit)![1];
  }
  return match[1] === '-' ? -seconds : seconds;
};

/** `+23h 2m`, `-5m`, `0`: the shortest text `parseClockOffset` reads back as these seconds. */
export const formatClockOffset = (seconds: number): string => {
  if (seconds === 0) return '0';
  let rest = Math.abs(Math.round(seconds));
  const parts: string[] = [];
  for (const [unit, size] of UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${count}${unit}`);
  }
  return `${seconds < 0 ? '-' : '+'}${parts.join(' ')}`;
};
