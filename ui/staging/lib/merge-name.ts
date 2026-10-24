/**
 * Which of two suggested groups being merged gives the merged one its name. The page keeps that
 * group and merges the other into it, so the name is the kept group's own: a person's stays
 * theirs, and one the organizer gave stays its to renew for the merged dates. Pure, so the rule is
 * tested without a page.
 */

/** What the rule reads of an `album list` row. */
type NamedRow = { title: string; memberCount?: number; staging: { named?: true } };

const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DATES_ONLY = new RegExp(`^(?:\\d{1,4}|${MONTH}|[–-]|\\s)+$`);

/**
 * Whether a name is dates and nothing else, as the organizer names a group it knows no occasion
 * or place for: `3 Aug 2014`, `3–9 Aug 2014`, `Jun–Aug 1975`, `1975–1977`.
 */
export const isBareDate = (name: string): boolean => DATES_ONLY.test(name.trim()) && /\d{4}/.test(name);

/**
 * The group of `into` and `other` whose name the merged group takes: a name a person gave, then
 * one that says what or where over bare dates, then the larger group's; on a tie, `into`, the
 * group merged into.
 */
export function nameGiver<T extends NamedRow>(into: T, other: T): T {
  const named = (row: T) => row.staging.named === true;
  if (named(into) !== named(other)) return named(into) ? into : other;
  if (isBareDate(into.title) !== isBareDate(other.title)) return isBareDate(into.title) ? other : into;
  return (other.memberCount ?? 0) > (into.memberCount ?? 0) ? other : into;
}
