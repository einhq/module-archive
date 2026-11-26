/**
 * A group's name as its card's header shows it: without the dates the organizer ends a name with
 * (`lib/staging/naming.ts`'s `<what> · <where> · <when>`), which the line under it says already.
 * A name that is only dates keeps them, as it says nothing else.
 */

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';

/** `3 Aug 2014`, `3–9 Aug 2014`, `28 Jul – 3 Aug 2014`, `Jun–Aug 1975`, `1975–1977` and the like: days, months, years and dashes, with a year. */
const DATES = new RegExp(`^(?:\\d{1,2}|${MONTH}|\\d{4}|[–-]|\\s)+$`);
const YEAR = /\b\d{4}\b/;

const isDates = (part: string): boolean => DATES.test(part) && YEAR.test(part);

export function cardTitle(title: string): string {
  const parts = title.split(' · ');
  if (parts.length < 2 || !isDates(parts[parts.length - 1].trim())) return title;
  return parts.slice(0, -1).join(' · ');
}
