/**
 * A video's chapters on its timeline: which one a time is in, where the skip buttons go, and the
 * segments the timeline is drawn as. `starts` are the chapters' starts in seconds, the first 0.
 * Pure, so it is tested without a browser.
 */

/**
 * Slack in comparing a time with a start. Safari rounds `currentTime` to its media timescale, so a
 * seek to a start can read back a hair before it — and "next" would then find the same start again.
 */
const SLACK = 0.02;

/** How far into a chapter "previous" means its own start rather than the chapter before. */
const RESTART_SECONDS = 2;

/** The chapter `seconds` is in, by index. */
export const chapterIndex = (starts: number[], seconds: number): number => {
  let low = 0;
  let high = starts.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] - SLACK <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};

/** Where a seek to a chapter lands: just inside it, so the time reads as that chapter's. */
export const chapterSeek = (start: number): number => start + SLACK;

/** The start "next" goes to, or null in the last chapter. */
export const nextChapterStart = (starts: number[], seconds: number): number | null => {
  const index = chapterIndex(starts, seconds);
  return index + 1 < starts.length ? starts[index + 1] : null;
};

/** The start "previous" goes to: this chapter's own after its first two seconds, else the one before. */
export const previousChapterStart = (starts: number[], seconds: number): number => {
  const index = chapterIndex(starts, seconds);
  return index === 0 || seconds - starts[index] > RESTART_SECONDS ? starts[index] : starts[index - 1];
};

/** Each chapter as a share of the timeline, `[start, end)` from 0 to 1. */
export const chapterSegments = (starts: number[], duration: number): { start: number; end: number }[] =>
  duration > 0 ? starts.map((start, i) => ({ start: start / duration, end: Math.min((starts[i + 1] ?? duration) / duration, 1) })) : [];

/**
 * Whether the timeline can draw its chapters apart, with a gap between each, at `width` pixels:
 * only while the narrowest is wide enough to read as a piece of track. Below that, a tick at each start.
 */
export const segmentsFit = (starts: number[], duration: number, width: number, least = 6): boolean =>
  duration > 0 && chapterSegments(starts, duration).every((segment) => (segment.end - segment.start) * width >= least);

/** "Chapter 3 of 8". */
export const chapterLabel = (starts: number[], seconds: number): string => `Chapter ${chapterIndex(starts, seconds) + 1} of ${starts.length}`;
