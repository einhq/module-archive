import { bucketByDate, bucketLabel, MONTHS } from '@ein/ui/lib';

/**
 * The parts an open group is shown in, and what `[`, `]`, S and the part keys act on: a section
 * per day, or for a long group (an Everyday lane of a year) a section per month whose header
 * carries its days as chips; the pictures without a date last, in a section of their own. A date
 * vaguer than a day (`1975`, `1975-06`) is a part of its own, as it is in a timeline. Pure, so it
 * is tested without a page.
 */

/** Days an open group shows a section each for; past this many, a section per month. */
export const PART_DAYS_MAX = 40;

/** A day of a month section: its date, what its chip says, its pictures and where they start. */
type PartDay = { key: string; label: string; count: number; startIndex: number };

export type PartSection<T> = {
  /** Unique among the sections: the date and where its pictures start. */
  id: string;
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY` (a month when by month), and the empty string for no date. */
  key: string;
  label: string;
  items: T[];
  /** Where its first picture is in the group's pictures in order. */
  startIndex: number;
  /** By month, the days in it, in order. */
  days?: PartDay[];
};

/** The group's pictures in the order the sections show them, and the sections. */
type PartLayout<T> = { items: T[]; sections: PartSection<T>[]; byMonth: boolean };

const dayChip = (key: string): string => {
  const [, month, day] = key.split('-');
  return day ? `${Number(day)} ${(MONTHS[Number(month) - 1] ?? month).slice(0, 3)}` : 'No day';
};

/**
 * The sections of `items`, in the order given (time order) but for the pictures without a date,
 * which come last. `dateOf` is a picture's capture time, as precise as it is known.
 */
export function partSections<T>(items: readonly T[], dateOf: (item: T) => string | undefined): PartLayout<T> {
  const dated = items.filter((item) => dateOf(item));
  const undated = items.filter((item) => !dateOf(item));
  const days = bucketByDate(dated, dateOf, 'day');
  const byMonth = days.length > PART_DAYS_MAX;
  const sections: PartSection<T>[] = byMonth
    ? bucketByDate(dated, dateOf, 'month').map((month) => ({
      id: `${month.key}:${month.startIndex}`,
      key: month.key,
      label: bucketLabel(month.key),
      items: month.items,
      startIndex: month.startIndex,
      days: bucketByDate(month.items, dateOf, 'day').map((day) => ({
        key: day.key,
        label: dayChip(day.key),
        count: day.items.length,
        startIndex: month.startIndex + day.startIndex,
      })),
    }))
    : days.map((day) => ({ id: `${day.key}:${day.startIndex}`, key: day.key, label: bucketLabel(day.key), items: day.items, startIndex: day.startIndex }));
  if (undated.length > 0) sections.push({ id: `:${dated.length}`, key: '', label: 'No date', items: undated, startIndex: dated.length });
  return { items: [...dated, ...undated], sections, byMonth };
}

/** The section `step` (1 for `]`, -1 for `[`) from the one `from`: the first or last when there is none yet, and `from` itself at either end. */
export function stepPart(sections: readonly { id: string }[], from: string | null, step: 1 | -1): string | null {
  if (sections.length === 0) return null;
  const at = from === null ? -1 : sections.findIndex((section) => section.id === from);
  if (at < 0) return step === 1 ? sections[0].id : sections[sections.length - 1].id;
  return sections[Math.min(sections.length - 1, Math.max(0, at + step))].id;
}
