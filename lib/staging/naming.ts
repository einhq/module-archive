/**
 * What a suggested group is called: `<what> · <where> · <when>`, each part only when it is known.
 *
 * - **what**: a folder's label (a seed or a scan run), an occasion (a holiday, or someone's
 *   birthday in the picture), or, at home, the guests seen in most of it; for a group nothing
 *   else names, when in the week it was (`Saturday evening`, `Weekend`);
 * - **where**: a named location, a point of interest, or away from home the city or the country;
 * - **when**: the dates, at the precision its members' capture times have.
 *
 * Lanes have names of their own (`laneName`). Holidays are a short generic table: Christmas,
 * New Year, Midsummer and Easter, which is computed.
 *
 * The "when" of a suggested album's name, at the precision its members' capture times have.
 *
 * A capture time's precision is its own length (`1975`, `1975-06`, `1975-06-03T…`), and a name
 * must not claim more than that: a photo dated only `1975` has an instant on New Year's Eve 1974
 * in any zone east of Greenwich, and naming it after that instant's day says "31 Dec 1974".
 *
 *   one day                  3 Aug 2014
 *   days in one month        3–9 Aug 2014
 *   days in one year         28 Jul – 3 Aug 2014
 *   days across years        30 Dec 2014 – 2 Jan 2015
 *   months                   Jun 1975, Jun–Aug 1975, Nov 1975 – Feb 1976
 *   years                    1975, 1975–1977
 *
 * Members dated to the day or finer decide the name whenever there are any; the coarser ones are
 * then somewhere in it. Without them, months decide unless a year-only member makes it a year.
 */
import { parseCaptureTime } from '@ein/client';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthName = (month: string): string => MONTHS[Number(month) - 1];

/** `3 Aug 2014` – `9 Aug 2014` folded as far as the two share month and year. Days are `YYYY-MM-DD`. */
const daySpan = (first: string, last: string): string => {
  const [y1, m1, d1] = first.split('-');
  const [y2, m2, d2] = last.split('-');
  const one = `${Number(d1)} ${monthName(m1)} ${y1}`;
  if (first === last) return one;
  if (y1 === y2 && m1 === m2) return `${Number(d1)}–${Number(d2)} ${monthName(m2)} ${y2}`;
  if (y1 === y2) return `${Number(d1)} ${monthName(m1)} – ${Number(d2)} ${monthName(m2)} ${y2}`;
  return `${one} – ${Number(d2)} ${monthName(m2)} ${y2}`;
};

/** `Jun 1975`, `Jun–Aug 1975` or `Nov 1975 – Feb 1976`. Months are `YYYY-MM`. */
const monthSpan = (first: string, last: string): string => {
  const [y1, m1] = first.split('-');
  const [y2, m2] = last.split('-');
  if (first === last) return `${monthName(m1)} ${y1}`;
  if (y1 === y2) return `${monthName(m1)}–${monthName(m2)} ${y2}`;
  return `${monthName(m1)} ${y1} – ${monthName(m2)} ${y2}`;
};

const span = (values: string[]): [string, string] => {
  const sorted = values.toSorted();
  return [sorted[0], sorted[sorted.length - 1]];
};

/**
 * The dates part of a name for members captured at `takenAt` (wall clocks, as stored); undefined
 * when none of them is a capture time.
 */
export const formatDates = (takenAt: string[]): string | undefined => {
  const days: string[] = [];
  const months: string[] = [];
  const years: string[] = [];
  for (const value of takenAt) {
    const parts = parseCaptureTime(value, { allowFuture: true });
    if (!parts) continue;
    if (parts.day !== undefined) days.push(`${parts.year}-${parts.month}-${parts.day}`);
    else if (parts.month !== undefined) months.push(`${parts.year}-${parts.month}`);
    else years.push(parts.year);
  }
  if (days.length > 0) return daySpan(...span(days));
  if (months.length > 0 && years.length === 0) return monthSpan(...span(months));
  if (months.length + years.length === 0) return undefined;
  const [first, last] = span([...years, ...months.map((month) => month.slice(0, 4))]);
  return first === last ? first : `${first}–${last}`;
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The part of the day an hour is in: morning from 5, afternoon from 12, evening from 17 to midnight; the small hours are none. */
const partOfDay = (hour: number): string | undefined => hour >= 17 ? 'evening' : hour >= 12 ? 'afternoon' : hour >= 5 ? 'morning' : undefined;

/**
 * When in the week members captured at `takenAt` (wall clocks, as stored) were taken, for a name
 * with nothing else to say: one day whose times all fall in one part of it (`Saturday evening`),
 * or a Saturday and the Sunday after, with or without the Friday before (`Weekend`). Undefined
 * otherwise, and when a member dated to the day has no time of day.
 */
export const momentOf = (takenAt: string[]): string | undefined => {
  const days = new Set<string>();
  const parts = new Set<string | undefined>();
  for (const value of takenAt) {
    const time = parseCaptureTime(value, { allowFuture: true });
    if (!time || time.day === undefined) continue;
    if (time.hour === undefined) return undefined;
    days.add(`${time.year}-${time.month}-${time.day}`);
    parts.add(partOfDay(Number(time.hour)));
  }
  const sorted = [...days].sort();
  const weekdays = sorted.map((day) => new Date(`${day}T00:00:00Z`).getUTCDay());
  if (sorted.length === 1) {
    const [part] = parts;
    return parts.size === 1 && part ? `${WEEKDAYS[weekdays[0]]} ${part}` : undefined;
  }
  const consecutive = sorted.every((day, i) => i === 0 || Date.parse(`${day}T00:00:00Z`) - Date.parse(`${sorted[i - 1]}T00:00:00Z`) === 86_400_000);
  const weekend = weekdays.join() === '6,0' || weekdays.join() === '5,6,0';
  return consecutive && weekend ? 'Weekend' : undefined;
};

/** A name's parts joined by ` · `, leaving out those not known. */
export const groupName = (parts: { what?: string; where?: string; when?: string }): string =>
  [parts.what, parts.where, parts.when].filter((part): part is string => part !== undefined && part.trim() !== '').join(' · ');

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a UTC date. */
const isoDay = (date: Date): string => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Easter Sunday of `year` (Gregorian computus), `YYYY-MM-DD`. */
export const easterSunday = (year: number): string => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
};

/** A holiday: its family (days of one family next to each other are one occasion) and its own name. */
type Holiday = { family: 'Christmas' | 'New Year' | 'Midsummer' | 'Easter'; name: string };

const FIXED_HOLIDAYS: Record<string, Holiday> = {
  '12-24': { family: 'Christmas', name: 'Christmas Eve' },
  '12-25': { family: 'Christmas', name: 'Christmas Day' },
  '12-26': { family: 'Christmas', name: 'Boxing Day' },
  '12-31': { family: 'New Year', name: "New Year's Eve" },
  '01-01': { family: 'New Year', name: "New Year's Day" },
};

/** The holiday a local day (`YYYY-MM-DD`) is, if any. Midsummer Eve is the Friday from 19 to 25 June. */
export const holidayOf = (day: string): Holiday | undefined => {
  const fixed = FIXED_HOLIDAYS[day.slice(5, 10)];
  if (fixed) return fixed;
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  const [month, dom, weekday] = [date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()];
  if (month === 6 && weekday === 5 && dom >= 19 && dom <= 25) return { family: 'Midsummer', name: 'Midsummer Eve' };
  if (month === 6 && weekday === 6 && dom >= 20 && dom <= 26) return { family: 'Midsummer', name: 'Midsummer Day' };
  const easter = easterSunday(date.getUTCFullYear());
  if (day.slice(0, 10) === easter) return { family: 'Easter', name: 'Easter Sunday' };
  if (day.slice(0, 10) === isoDay(new Date(Date.parse(`${easter}T00:00:00Z`) - 86_400_000))) return { family: 'Easter', name: 'Easter Saturday' };
  return undefined;
};

/** Whether two local days are of one holiday family: Christmas Eve and Day, New Year's Eve and Day, and so on. */
export const holidayPair = (a: string, b: string): boolean => {
  const [x, y] = [holidayOf(a), holidayOf(b)];
  return x !== undefined && y !== undefined && x.family === y.family;
};

/** Someone in a group's pictures, as naming reads them: their name and when they were born. */
export type CastMember = { name: string; born?: string };

/**
 * What a group of the local days `days` is an occasion of: the holiday its days fall on (the
 * family's name when they cover more than one of its days), else the birthday of someone in its
 * pictures born on one of them. Undefined for neither.
 */
export const occasionOf = (days: string[], cast: CastMember[] = []): string | undefined => {
  const holidays = days.map(holidayOf).filter((holiday): holiday is Holiday => holiday !== undefined);
  if (holidays.length > 0) {
    const names = new Set(holidays.filter((holiday) => holiday.family === holidays[0].family).map((holiday) => holiday.name));
    return names.size > 1 ? holidays[0].family : holidays[0].name;
  }
  const monthDays = new Set(days.map((day) => day.slice(5, 10)));
  const born = cast.find((member) => member.born !== undefined && /^\d{4}-\d{2}-\d{2}/.test(member.born) && monthDays.has(member.born.slice(5, 10)));
  return born ? `${born.name}'s birthday` : undefined;
};

/** `With Anna`, `With Anna and Bo`. */
export const withGuests = (names: string[]): string | undefined => names.length === 0 ? undefined : `With ${names.slice(0, 2).join(' and ')}`;

/** The period a lane's key names (`2014`, `2014-06`), as a name says it: `2014`, `Jun 2014`. */
const periodName = (period: string): string => /^\d{4}-\d{2}$/.test(period) ? monthSpan(period, period) : period;

/** A chunk of a lane, numbered from 2: `Everyday · Jun 2014 (2)`. */
const chunked = (name: string, chunk: number): string => chunk > 1 ? `${name} (${chunk})` : name;

/**
 * What a lane is called: `Everyday · 2014` (or a month), `Screenshots and saved images · 2019`
 * (or `· Undated`), `1987 · <folder>` for pictures dated only to that year or month,
 * `Undated · <folder>`, and `<folder> · Jun 2019` for a month of a category grouped by month alone.
 */
export const laneName = (
  lane: { kind: 'loose' | 'clutter' | 'undated' | 'period' | 'month'; period?: string; folder?: string; chunk?: number },
): string => {
  const chunk = lane.chunk ?? 1;
  const folder = lane.folder ?? '';
  switch (lane.kind) {
    case 'loose':
      return chunked(groupName({ what: 'Everyday', when: lane.period && periodName(lane.period) }), chunk);
    case 'clutter':
      return chunked(groupName({ what: 'Screenshots and saved images', when: lane.period ? periodName(lane.period) : 'Undated' }), chunk);
    case 'undated':
      return chunked(groupName({ what: 'Undated', where: folder }), chunk);
    case 'period':
      return chunked(groupName({ what: lane.period && periodName(lane.period), where: folder }), chunk);
    case 'month':
      return chunked(groupName({ what: folder, when: lane.period && periodName(lane.period) }), chunk);
  }
};
