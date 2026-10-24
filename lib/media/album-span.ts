/**
 * An album's time span: its media's, from the first capture to the last, reaching out to the days
 * it was set by hand to start and end on (`spanStart`, `spanEnd`). A trip starts before its first
 * photo — the drive out, the flight — and the span is what the album's map draws routes for
 * (ein/core#468).
 *
 * A hand-set end only ever widens the span. It is kept while it lies beyond the media and dropped
 * once a capture reaches it, so the span follows the media from then on.
 */

import type { Command } from '@ein/client';
import { albumMembers } from '@archive/media/album-members';
import type { AlbumSpanRow } from '@archive/media/api';

/**
 * Earliest plausible capture date; the first surviving photograph is 1826, the
 * same floor `@archive/media/exif-date` applies to a parsed date.
 *
 * It earns its location on real data: `exif-extract` used to parse a dead camera
 * clock's `0000:00:00 00:00:00` into `0000-00-00T00:00:00`, and one such member
 * would otherwise date a 2015 album to the year zero. `@archive/media/exif-date` now
 * refuses those at the source, so this is defence rather than the fix — a span
 * is worth keeping honest against whatever a future importer promotes.
 */
const MIN_CAPTURE_DATE = '1826';

/** A hand-set end is a day, `YYYY-MM-DD`. */
export const SPAN_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The attrs a span is set by hand with. */
export const SPAN_KEYS = ['spanStart', 'spanEnd'] as const;

/** The media's own span: the first and last capture, and how many members there are. */
type MediaSpan = { mediaStart?: string; mediaEnd?: string; mediaCount: number };

/**
 * The span of an album's media, by listing it: every member, stacked photos included, since a
 * stack hides a photo from the grid but not from the album.
 */
export const mediaSpan = async (cmd: Command, path: string): Promise<MediaSpan> => {
  const { members } = await albumMembers(cmd, path);
  // Ordered and floored on the **instant** (`takenAtUtc`), reported as the **wall clock**
  // (`takenAt`). Which member is earliest is a question about when; what an album's span *says*
  // is a question about the calendar — and it has to be the second, because the global timeline
  // merges these spans with births, moves and events, whose dates are wall clocks and are
  // routinely no more precise than a year (core's `timeline/entry.ts`).
  const dated = members
    .map(({ node }) => ({ instant: node.attrs.takenAtUtc, wallClock: node.attrs.takenAt }))
    .filter((member): member is { instant: string; wallClock: string } =>
      typeof member.instant === 'string' && member.instant >= MIN_CAPTURE_DATE && typeof member.wallClock === 'string'
    )
    .sort((a, b) => a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : 0);
  if (dated.length === 0) return { mediaCount: members.length };
  return { mediaStart: dated[0].wallClock, mediaEnd: dated[dated.length - 1].wallClock, mediaCount: members.length };
};

const day = (attr: unknown): string | undefined => typeof attr === 'string' && SPAN_DAY.test(attr) ? attr : undefined;

/**
 * The span an album has, from its media and the ends set on it. A hand-set start is kept while
 * its day is before the media's first, a hand-set end while its day is after the media's last;
 * an album with nothing dated takes them as they are.
 */
export const albumSpan = (media: MediaSpan, attrs: Record<string, unknown>): Omit<AlbumSpanRow, 'path'> => {
  const firstDay = media.mediaStart?.slice(0, 10);
  const lastDay = media.mediaEnd?.slice(0, 10);
  const start = day(attrs.spanStart);
  const end = day(attrs.spanEnd);
  const spanStart = start && (!firstDay || start < firstDay) ? start : undefined;
  const spanEnd = end && (!lastDay || end > lastDay) ? end : undefined;
  return {
    ...media,
    timeStart: spanStart ?? media.mediaStart ?? spanEnd,
    timeEnd: spanEnd ?? media.mediaEnd ?? spanStart,
    spanStart,
    spanEnd,
  };
};
