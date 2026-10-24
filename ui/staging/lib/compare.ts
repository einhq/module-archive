/**
 * The compare strip's arithmetic: where in a candidate album its pictures are read from (the day
 * before the group's first, so the strip opens on the group's own days), and the pictures it got
 * as days, each marked when the group has pictures that day too. Pure, so it is tested without a
 * page.
 */
import { MONTHS } from '@ein/ui/lib';

const DAY_MS = 86_400_000;

/** The day a candidate's pictures are read from: the day before `timeStart`'s, `YYYY-MM-DD`; none for an undated group. */
export function seekDay(timeStart: string | undefined): string | undefined {
  if (!timeStart || !/^\d{4}-\d{2}-\d{2}/.test(timeStart)) return undefined;
  return new Date(Date.parse(`${timeStart.slice(0, 10)}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** The days from `timeStart`'s to `timeEnd`'s, both included; none for an undated group. */
export function daysBetween(timeStart: string | undefined, timeEnd: string | undefined): Set<string> {
  const days = new Set<string>();
  if (!timeStart || !/^\d{4}-\d{2}-\d{2}/.test(timeStart)) return days;
  const last = timeEnd && /^\d{4}-\d{2}-\d{2}/.test(timeEnd) ? timeEnd.slice(0, 10) : timeStart.slice(0, 10);
  for (let at = Date.parse(`${timeStart.slice(0, 10)}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`) && days.size < 400; at += DAY_MS) {
    days.add(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** A day of the strip: its date, its chip's words, its pictures, and whether the group has pictures that day. */
type StripDay<T> = { day: string; label: string; items: T[]; ours: boolean };

const dayLabel = (day: string): string => {
  const [, month, date] = day.split('-');
  return `${Number(date)} ${(MONTHS[Number(month) - 1] ?? month).slice(0, 3)}`;
};

/** `items` as days in the order they come, by `dateOf` (a wall clock); those without a date as one day of their own, last. */
export function stripDays<T>(items: readonly T[], dateOf: (item: T) => string | undefined, ours: ReadonlySet<string>): StripDay<T>[] {
  const days: StripDay<T>[] = [];
  const undated: T[] = [];
  for (const item of items) {
    const date = dateOf(item);
    const day = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : undefined;
    if (!day) {
      undated.push(item);
      continue;
    }
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(item);
    else days.push({ day, label: dayLabel(day), items: [item], ours: ours.has(day) });
  }
  if (undated.length > 0) days.push({ day: '', label: 'No date', items: undated, ours: false });
  return days;
}

/** The highlighted candidate after `step` from `at`, among `count`, held at either end. */
export const stepCandidate = (at: number, step: 1 | -1, count: number): number => count === 0 ? 0 : Math.min(count - 1, Math.max(0, at + step));
