/**
 * How sure a date is. A person's `born` and `died` and an event's `date` are `YYYY[-MM[-DD]]`; a
 * qualifier beside them (`bornQualifier`, `diedQualifier`, `dateQualifier`) says the day was
 * about then, before it or after it. Without one the date is what happened. The date is still
 * what orders and pages a timeline, so an uncertain date sits at its year. Free of imports, so
 * the pages use it as the commands do.
 */

export const DATE_QUALIFIERS = ['about', 'before', 'after'] as const;
export type DateQualifier = typeof DATE_QUALIFIERS[number];

export const isDateQualifier = (value: unknown): value is DateQualifier => DATE_QUALIFIERS.includes(value as DateQualifier);

/** The attr beside a person's life date that qualifies it. */
export const QUALIFIER_ATTRS = { born: 'bornQualifier', died: 'diedQualifier' } as const;

/** The attr beside an event's `date` that qualifies it. */
export const EVENT_QUALIFIER_ATTR = 'dateQualifier';

/** A date as it is shown: `~1890` about then, `before 1900`, `after 1900`, else the date itself. */
export const qualifiedDate = (date: string, qualifier: unknown): string => {
  if (qualifier === 'about') return `~${date}`;
  if (qualifier === 'before' || qualifier === 'after') return `${qualifier} ${date}`;
  return date;
};

/** A date's year as it is shown, qualified as `qualifiedDate` does; empty without a date. */
export const qualifiedYear = (date: string | null | undefined, qualifier: unknown): string => date ? qualifiedDate(date.slice(0, 4), qualifier) : '';

/** The qualifiers of a person's `born` and `died`, for an answer that carries the dates: each only beside its date. */
export const lifeQualifiers = (attrs: Record<string, unknown>): { bornQualifier?: DateQualifier; diedQualifier?: DateQualifier } => ({
  ...(attrs.born && isDateQualifier(attrs.bornQualifier) ? { bornQualifier: attrs.bornQualifier } : {}),
  ...(attrs.died && isDateQualifier(attrs.diedQualifier) ? { diedQualifier: attrs.diedQualifier } : {}),
});
