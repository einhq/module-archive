/**
 * The arithmetic of the lightbox's players' timelines: where a pointer or a key puts the playhead.
 *
 * Pure, so the audio and the video player agree on it and it is tested without a browser.
 */
import { chapterSeek, nextChapterStart, previousChapterStart } from './chapters.ts';

/** What an arrow key moves the playhead by, in seconds, while the timeline has focus. */
const SCRUB_STEP_SECONDS = 5;

/** What PageUp and PageDown move it by, as a share of the whole, in a recording without chapters. */
const SCRUB_PAGE_SHARE = 0.1;

/** A length the element has not measured yet is NaN or Infinity; it bounds nothing above. */
const known = (duration: number): boolean => Number.isFinite(duration) && duration > 0;

/** `seconds` held inside the recording. */
export const clampTime = (seconds: number, duration: number): number => known(duration) ? Math.min(Math.max(seconds, 0), duration) : Math.max(seconds, 0);

/** The time under `clientX` on a timeline drawn across `rect`, or null while there is no length to map onto. */
export const timeAtClientX = (clientX: number, rect: { left: number; width: number }, duration: number): number | null => {
  if (rect.width <= 0 || !known(duration)) return null;
  return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * duration;
};

/** The parts of a keydown the timeline reads. */
export type ScrubKey = { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

/**
 * Where a key pressed on the focused timeline moves the playhead, or null for a key it leaves alone.
 *
 * The keys of the ARIA slider pattern; PageUp and PageDown go by chapter when there are `chapters`
 * (their starts). Anything with a modifier is left to whoever else listens: the lightbox's own
 * bindings match their modifiers exactly.
 */
export const scrubKeyTarget = (event: ScrubKey, seconds: number, duration: number, chapters?: number[]): number | null => {
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampTime(seconds - SCRUB_STEP_SECONDS, duration);
    case 'ArrowRight':
    case 'ArrowUp':
      return clampTime(seconds + SCRUB_STEP_SECONDS, duration);
    case 'PageDown':
      if (chapters && chapters.length > 1) return chapterSeek(previousChapterStart(chapters, seconds));
      return known(duration) ? clampTime(seconds - duration * SCRUB_PAGE_SHARE, duration) : null;
    case 'PageUp': {
      if (chapters && chapters.length > 1) {
        const next = nextChapterStart(chapters, seconds);
        return next === null ? null : chapterSeek(next);
      }
      return known(duration) ? clampTime(seconds + duration * SCRUB_PAGE_SHARE, duration) : null;
    }
    case 'Home':
      return 0;
    case 'End':
      return known(duration) ? duration : null;
    default:
      return null;
  }
};

/** The playhead as a share of the whole, 0 before the length is known. */
export const progressOf = (seconds: number, duration: number): number => known(duration) ? Math.min(Math.max(seconds / duration, 0), 1) : 0;
