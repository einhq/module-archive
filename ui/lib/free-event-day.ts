/**
 * The day a new event in `days` is most likely about: the first one no event already has, the
 * first of them when every day has one, and nothing when there are none. Days and event dates
 * are compared by their `YYYY-MM-DD`.
 */
export function firstFreeDay(days: readonly string[], eventDates: readonly string[]): string | undefined {
  const sorted = [...days].sort();
  const taken = new Set(eventDates.map((date) => date.slice(0, 10)));
  return sorted.find((day) => !taken.has(day)) ?? sorted[0];
}
