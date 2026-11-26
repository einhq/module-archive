/**
 * Where a suggested album's pictures are read from to show those nearest a group's days: the day
 * after the group's last (a newest-first read), or the day before its first (an oldest-first one).
 * Pure, so it is tested without a page.
 */

const DAY_MS = 86_400_000;

const dayShifted = (time: string | undefined, days: number): string | undefined => {
  if (!time || !/^\d{4}-\d{2}-\d{2}/.test(time)) return undefined;
  return new Date(Date.parse(`${time.slice(0, 10)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
};

/** The day before `timeStart`'s, `YYYY-MM-DD`: where an oldest-first read starts; none for an undated group. */
export const seekDay = (timeStart: string | undefined): string | undefined => dayShifted(timeStart, -1);

/** The day after `time`'s, `YYYY-MM-DD`: where a newest-first read starts; none for an undated group. */
export const dayAfter = (time: string | undefined): string | undefined => dayShifted(time, 1);
