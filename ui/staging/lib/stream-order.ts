/**
 * The order of the Sort stream and where its cursor goes. Pure, so it is tested without a page.
 *
 * The stream reads oldest first, as a story is told and as neighbours are merged; newest first
 * reverses the dated groups. Groups without a date come last either way, by name: the order
 * never rests on how the store collates slugs, so a seed or a folder stands at its own time.
 */

/** What the order reads of an `album list` row. */
type OrderRow = { name: string; timeStart?: string };

/** `rows` in stream order: dated by start time (and name, for ties), then the undated by name. */
export function streamOrder<T extends OrderRow>(rows: readonly T[], { newestFirst = false }: { newestFirst?: boolean } = {}): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const dated = rows.filter((row) => row.timeStart).sort((a, b) => a.timeStart!.localeCompare(b.timeStart!) || byName(a, b));
  const undated = rows.filter((row) => !row.timeStart).sort(byName);
  return [...(newestFirst ? dated.reverse() : dated), ...undated];
}

/**
 * The row J (`step` 1) or K (-1) moves to from `from`: its neighbour in the view, the first (or
 * last) when there is no cursor yet, and `from` itself at either end. Null for an empty view.
 */
export function stepFrom(view: readonly string[], from: string | null, step: 1 | -1): string | null {
  if (view.length === 0) return null;
  const at = from === null ? -1 : view.indexOf(from);
  if (at < 0) return step === 1 ? view[0] : view[view.length - 1];
  return view[Math.min(view.length - 1, Math.max(0, at + step))];
}

/**
 * Where the cursor goes once the row `decided` is being filed: the first row after it in the view
 * that `skip` does not rule out (one being decided, or one whose decision failed), else the
 * nearest such row before it, else none. A row the reader stepped past without deciding is still
 * in the view, and is passed over only because it lies behind.
 */
export function nextAfterDecision(view: readonly string[], decided: string, skip: (name: string) => boolean): string | null {
  const at = view.indexOf(decided);
  if (at < 0) return view.find((name) => !skip(name)) ?? null;
  for (let index = at + 1; index < view.length; index++) if (!skip(view[index])) return view[index];
  for (let index = at - 1; index >= 0; index--) if (!skip(view[index])) return view[index];
  return null;
}
