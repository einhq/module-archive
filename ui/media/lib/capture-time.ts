/**
 * Reading a capture time in the browser.
 *
 * The server stores two attrs and they answer different questions:
 * `takenAt` is the **wall clock**, at whatever precision is honest and carrying the offset the
 * photographer was standing in when that is known; `takenAtUtc` is the instant, and is what
 * ordering and cursors use. This file is only about the first one, because the first one is
 * what a person reads.
 *
 * The format is the contract; this is the browser's reader for it.
 *
 * Two rules do most of the work here.
 *
 * **Never render precision the value does not have.** `1975` is a year. Handing it to
 * `Date.parse` produces midnight on New Year's Day, and rendering that gives "1 Jan 1975,
 * 01:00" — a day, an hour and a minute nobody ever knew, presented exactly as confidently as a
 * real timestamp.
 *
 * **Show the clock the photographer was reading.** A photograph taken at noon in Tokyo is a
 * noon photograph; converting it to the viewer's own zone makes it a 4am one. So when `takenAt`
 * carries an offset it is rendered *in that offset*, and the viewer's locale is the fallback
 * for the files — most of them — that carry none.
 */

type TimePrecision = 'year' | 'month' | 'day' | 'minute' | 'second';

const CAPTURE_TIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[-+]\d{2}:\d{2})?)?)?)?$/;

type CaptureTimeParts = {
  year: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  offset?: string;
  precision: TimePrecision;
};

/** Split a capture time into its parts, or undefined when the string is not one. */
function parseCaptureTime(value?: string): CaptureTimeParts | undefined {
  if (!value) return undefined;
  const match = CAPTURE_TIME.exec(value.trim());
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second, zone] = match;
  const precision: TimePrecision = second !== undefined ? 'second' : hour !== undefined ? 'minute' : day !== undefined ? 'day' : month !== undefined ? 'month' : 'year';

  return { year, month, day, hour, minute, second, offset: zone === 'Z' ? '+00:00' : zone, precision };
}

/** How much of a capture time is real, or undefined when it is not one. */
export const precisionOf = (value?: string): TimePrecision | undefined => parseCaptureTime(value)?.precision;

/** The year of a capture time, or undefined when it is not one. */
export const yearOf = (value?: string): string | undefined => parseCaptureTime(value)?.year;

/** Whether a value claims less than a whole day — a year or a month. */
export const isVague = (value?: string): boolean => {
  const precision = precisionOf(value);
  return precision === 'year' || precision === 'month';
};

const MONTHS = (locale?: string) => new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });

/** A capture time split into what a caption can lay out on separate lines. */
export type TakenParts = {
  /** The calendar part: "1975", "March 2004", "30 April 2003", or the value verbatim when unreadable. */
  date: string;
  /** The wall clock, present only below day precision. */
  clock?: string;
};

type FormatTakenOptions = {
  /** Include seconds in the clock when the value has them. */
  seconds?: boolean;
  /** Prefix the day's name once the value is precise enough to have one; `short` abbreviates it. */
  weekday?: boolean | 'short';
  /** The month written out — "30 April 2003", as the media grid's headers say it. */
  long?: boolean;
};

/**
 * A capture time as a person should read it, at exactly the precision it has, in parts.
 *
 * `1975` → "1975" · `2004-03` → "March 2004" · `2003-04-30` → "30 Apr 2003" ·
 * a full value → "30 Apr 2003" plus the clock "14:03", rendered in its own offset when it has
 * one. Seconds are left out unless asked for: a list of dates reads better without them, but
 * a single photograph's caption in the lightbox wants the whole timestamp, since a burst of
 * frames taken in the same minute is told apart by nothing else. `weekday` prefixes the
 * day's name ("Wednesday, 30 Apr 2003") once the value is precise enough to have one.
 *
 * A string that is not a capture time is returned as it came, rather than swallowed: a value
 * this cannot read is a bug worth seeing rather than a blank where a date should be.
 */
export function formatTakenParts(value?: string, locale?: string, options: FormatTakenOptions = {}): TakenParts {
  const parts = parseCaptureTime(value);
  if (!parts) return { date: value ?? '' };

  if (parts.precision === 'year') return { date: parts.year };
  if (parts.precision === 'month') {
    // Formatted through Intl so the month is in the reader's language, but pinned to UTC so the
    // date it is built from cannot slip across a boundary and name the month before.
    const at = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1));
    return { date: `${MONTHS(locale).format(at)} ${parts.year}` };
  }

  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const calendar = options.long
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(day)
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(day);
  // `dateStyle` refuses to be combined with `weekday`, so the name is formatted on its own.
  const weekday = options.weekday === 'short' ? 'short' : 'long';
  const date = options.weekday ? `${new Intl.DateTimeFormat(locale, { weekday, timeZone: 'UTC' }).format(day)}, ${calendar}` : calendar;
  if (parts.precision === 'day') return { date };

  // Below a day the wall clock is printed as written, not reformatted: it is already in the
  // zone it should be read in, and passing it through a Date would convert it into the
  // viewer's.
  const clock = options.seconds && parts.second !== undefined ? `${parts.hour}:${parts.minute}:${parts.second}` : `${parts.hour}:${parts.minute}`;
  return { date, clock };
}

/** `formatTakenParts` on one line: "30 Apr 2003, 14:03". */
export function formatTaken(value?: string, locale?: string, options: FormatTakenOptions = {}): string {
  const { date, clock } = formatTakenParts(value, locale, options);
  return clock ? `${date}, ${clock}` : date;
}

/** The offset a capture time carries, in seconds, or undefined when it names no clock. */
export function offsetOf(value?: string): number | undefined {
  const offset = parseCaptureTime(value)?.offset;
  if (offset === undefined) return undefined;
  const sign = offset.startsWith('-') ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(':').map(Number);
  return sign * (hours * 3600 + minutes * 60);
}

/**
 * The same instant in the viewer's own zone, when that differs from the capture zone.
 *
 * Returns undefined when there is nothing to say: no instant, no offset on the capture time, or
 * a viewer standing in the same offset the photograph was taken in — the common case, where it
 * would be noise on every lightbox.
 */
export function viewerLocalTime(takenAt?: string, takenAtUtc?: string, locale?: string): string | undefined {
  if (!takenAtUtc) return undefined;
  const captureOffset = offsetOf(takenAt);
  if (captureOffset === undefined) return undefined;

  const at = new Date(takenAtUtc);
  if (Number.isNaN(at.getTime())) return undefined;
  // `getTimezoneOffset` counts minutes *behind* UTC, hence the sign flip.
  if (-at.getTimezoneOffset() * 60 === captureOffset) return undefined;

  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(at);
}

/** How a source is worth naming to a reader. */
const SOURCE_LABELS: Record<string, string> = {
  manual: 'entered by hand',
  sidecar: 'from Google Photos or a sidecar',
  gps: 'from GPS',
  device: 'from the camera clock',
  name: 'from the file name',
};

/**
 * Where a capture time came from, in words: its source (`takenAtSource`), and for a digitized copy
 * (a scan) that the scan's own clocks were not believed. Undefined when there is nothing to say.
 */
export function timeSourceLabel(source?: string, digitized?: boolean): string | undefined {
  const label = source ? SOURCE_LABELS[source] ?? source : undefined;
  const scan = digitized ? 'a scan: its scanner’s clocks are not when it was taken' : undefined;
  return [label, scan].filter(Boolean).join(' · ') || undefined;
}
