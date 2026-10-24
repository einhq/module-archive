/**
 * Recomputing capture times for an ordered batch of media.
 *
 * The problem this solves: a camera whose clock was never set, or was set wrong, dates a whole
 * afternoon incorrectly — or not at all. What is nearly always still right is the *spacing*
 * between the pictures, and the order they were taken in. So the correction is anchored rather
 * than absolute: say when the first one happened and let everything else keep its distance.
 *
 * One walk over the list does all of it. For each file the new time is the previous new time
 * plus a delta, where the delta is what the two originals say when both have one and a fixed gap
 * when they do not. That single rule covers every case the dialog offers — a fully dated batch
 * shifts wholesale (which is also how "the clock was three hours off" is expressed: set the
 * start to the corrected first picture), an undated batch spreads at one a minute, and a mixed
 * batch does both without a special case.
 *
 * Pure and UI-free so the arithmetic can be tested without a browser.
 */

/** One file in the batch. `original` is absent when it has no capture time at all. */
export type RetimeEntry = {
  path: string;
  /** Epoch ms, parsed as naive wall-clock. See `parseNaive`. */
  original?: number;
  /**
   * Set when the file's stored time is **vaguer than a day** — a bare `1975` or `2004-03`.
   *
   * Such a row is left exactly as it is unless the user pins it. Rebasing it would turn "some
   * time in 1975", which is all anybody ever knew, into a specific minute of a specific
   * afternoon; and there is no spacing to preserve either, since a year has no position within
   * itself. Files known only to a year or a month routinely sit in the same album as dated ones.
   *
   * Pinning a row is the opt-in: an anchor is an explicit statement about *this* picture and
   * overrides this the way it overrides everything else.
   */
  vague?: boolean;
};

type RetimeInput = {
  /** Paths in the order the user settled on — sorted or hand-dragged. */
  order: string[];
  entries: Map<string, RetimeEntry>;
  /** Epoch ms for the first entry, unless it carries an anchor of its own. */
  start: number;
  /**
   * Hand-edited times, keyed by path rather than index so re-sorting the list does not move an
   * edit onto a different picture. An anchor pins its own row and everything after it follows,
   * which falls out of the walk rather than being special-cased.
   */
  anchors: Map<string, number>;
  gapMs: number;
};

/** The default spread for media with nothing to derive a spacing from. */
export const DEFAULT_GAP_MS = 60_000;

/**
 * How far apart two consecutive files should end up.
 *
 * A negative difference means the chosen order contradicts the original times — the user dragged
 * a picture in front of one taken earlier. The order they set wins, so the pair falls back to the
 * gap rather than travelling backwards. Zero is left alone: a burst of frames shot in the same
 * second is genuinely simultaneous, and spreading it a minute apart would be an invention.
 */
function deltaBetween(previous: RetimeEntry | undefined, current: RetimeEntry | undefined, gapMs: number): number {
  // A vague row contributes no spacing in either direction: "some time in 1975" is not a
  // distance from anything, so its neighbours fall back to the gap exactly as an undated row's do.
  if (previous?.vague || current?.vague) return gapMs;
  if (previous?.original === undefined || current?.original === undefined) return gapMs;
  const delta = current.original - previous.original;
  return delta >= 0 ? delta : gapMs;
}

/**
 * New capture times, keyed by path.
 *
 * Every path in `order` gets one **except** an unpinned vague row, which is deliberately absent:
 * the caller writes only what the map holds, so a year stays a year.
 */
export function retime({ order, entries, start, anchors, gapMs }: RetimeInput): Map<string, number> {
  const times = new Map<string, number>();
  let previousTime = start;
  // The row `start` actually lands on is the first one that *takes* a time, which is not
  // necessarily `order[0]`: a batch whose first picture is known only to a year begins at the
  // first one after it that has a real time to place.
  let previousPath: string | undefined;

  order.forEach((path) => {
    const anchor = anchors.get(path);
    if (anchor === undefined && entries.get(path)?.vague) {
      // Left alone, and left out of the walk: the row keeps whatever it has, and the rows after
      // it continue from the last row that had a real time rather than from a year.
      return;
    }
    const time = anchor ??
      (previousPath === undefined ? start : previousTime + deltaBetween(entries.get(previousPath), entries.get(path), gapMs));
    times.set(path, time);
    previousTime = time;
    previousPath = path;
  });

  return times;
}

/**
 * An ISO capture time as epoch ms, read as wall-clock.
 *
 * `takenAt` usually has no zone, because exif has none — and a bare `YYYY-MM-DDTHH:mm:ss` is
 * parsed as local time, which is what makes the whole naive round-trip work. The space-separated
 * form is accepted too: that is what Mantine's date components emit.
 */
export function parseNaive(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? undefined : parsed;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local wall-clock date and time, split so both spellings share one implementation. */
function parts(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

/** What gets written to `takenAtManual`: naive local, no zone, matching what exif yields. */
export function formatNaive(ms: number): string {
  const { date, time } = parts(ms);
  return `${date}T${time}`;
}

/** The same instant in the string form Mantine's date components take and emit. */
export function formatPicker(ms: number): string {
  const { date, time } = parts(ms);
  return `${date} ${time}`;
}

/**
 * Ordered by the time the files currently claim, earliest first, undated last.
 *
 * Undated media goes to the end rather than to the front, matching how `search` orders it: a file
 * with no date is not a file from the year zero.
 */
export function sortByTime(order: string[], entries: Map<string, RetimeEntry>): string[] {
  return [...order].sort((a, b) => {
    const left = entries.get(a)?.original;
    const right = entries.get(b)?.original;
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

/** Numeric collation, so `IMG_2` sorts before `IMG_10` the way a person would file them. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortByName(order: string[], names: Map<string, string>): string[] {
  return [...order].sort((a, b) => collator.compare(names.get(a) ?? a, names.get(b) ?? b));
}
