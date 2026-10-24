/** Either end of a residence (or any dated tie); both may be unknown. */
type Span = { from?: string; to?: string };

/**
 * The span as a line, and "dates unknown" when there is none.
 *
 * Saying so out loud is the point rather than a fallback: imported residences
 * have no dates at all, and a row that quietly showed a name and nothing else
 * would give no hint that anything is missing — or that the pencil beside it
 * is how a move reaches a timeline.
 */
export const spanLine = (row: Span): string => {
  if (row.from && row.to) return `${row.from} – ${row.to}`;
  if (row.from) return `since ${row.from}`;
  if (row.to) return `until ${row.to}`;
  return 'dates unknown';
};
