/**
 * A year slider's track laid out by the years that hold something: one step per such year, the
 * empty years between them collapsed. A sparse century then takes no more of the track than one
 * busy year, and the decades most pictures are from get the room. The timeline scrubber gives
 * occupied months equal reach the same way.
 *
 * A scale is the years it steps through, ascending and without repeats; a position is an index
 * into it.
 */
type YearScale = readonly number[];

/** The scale for `years` (any order, repeats allowed), with `always` reachable too: an end the track must reach. */
export function yearScale(years: Iterable<number>, ...always: number[]): number[] {
  return [...new Set([...years, ...always])].filter(Number.isFinite).toSorted((a, b) => a - b);
}

/** The position of the first year at or after `year`: where a range's lower handle goes. */
export function positionAtOrAfter(scale: YearScale, year: number): number {
  const at = scale.findIndex((candidate) => candidate >= year);
  return at < 0 ? Math.max(0, scale.length - 1) : at;
}

/** The position of the last year at or before `year`: where a range's upper handle, or a lone thumb, goes. */
export function positionAtOrBefore(scale: YearScale, year: number): number {
  const at = scale.findLastIndex((candidate) => candidate <= year);
  return Math.max(0, at);
}

/** The year at a slider position, clamped to the track. */
export function yearAt(scale: YearScale, position: number): number {
  return scale[Math.min(scale.length - 1, Math.max(0, Math.round(position)))];
}

const LABEL_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];

/**
 * At most `max` labels for the track, each the year at its position: the first year of each
 * decade, century or whatever step keeps the count down, skipping one that would crowd the label
 * before it.
 */
export function scaleMarks(scale: YearScale, max: number): { position: number; label: string }[] {
  if (scale.length === 0 || max <= 0) return [];
  const bucketsOf = (step: number) => new Set(scale.map((year) => Math.floor(year / step))).size;
  const step = LABEL_STEPS.find((candidate) => bucketsOf(candidate) <= max) ?? LABEL_STEPS.at(-1)!;
  const gap = (scale.length - 1) / (max * 1.5);

  const marks: { position: number; label: string }[] = [];
  let bucket: number | undefined;
  scale.forEach((year, position) => {
    const here = Math.floor(year / step);
    if (here === bucket) return;
    bucket = here;
    const previous = marks.at(-1);
    if (previous && position - previous.position < gap) return;
    marks.push({ position, label: String(year) });
  });
  return marks;
}
