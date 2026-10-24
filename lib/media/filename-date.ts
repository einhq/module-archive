/**
 * Capture times in file names: what a phone, a messenger, a screenshot tool or a desktop
 * uploader writes into the name of a file it makes.
 *
 * A name is the weakest of the time sources (`@archive/media/capture-resolve` uses it last, and
 * only where a category says its names are dates), so the patterns are narrow: each is anchored
 * at the start of the name, names exactly one writer's form, and the first that matches decides.
 * A scanner's running number (`IMG_20190601_0001`) matches none of them. Values are checked: a
 * year from 1995 to next year, a day the calendar has, a time the clock has.
 *
 * Pure: the answer is a capture time as `whenName` stores it, `YYYY-MM-DD` when the name gives
 * only a day, `YYYY-MM-DDTHH:MM:SS` for a wall clock, and with `Z` when the writer keeps its
 * clock in UTC.
 */

import { parseCaptureTime } from '@ein/client';

/** The earliest year a name is believed for: before it no device wrote dates into names. */
const MIN_NAME_YEAR = 1995;

type Pattern = {
  /** Anchored at the start of the name. */
  match: RegExp;
  /** The capture time the groups spell, unchecked. */
  value: (groups: string[]) => string;
};

/** `YYYYMMDD` as `YYYY-MM-DD`. */
const day8 = (digits: string): string => `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
/** `HHMMSS` as `HH:MM:SS`. */
const time6 = (digits: string): string => `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;

const PATTERNS: Pattern[] = [
  // Android and many cameras' own phone apps: IMG_20190601_123456.jpg, VID_…, PANO_…, MVIMG_….
  { match: /^(?:IMG|VID|PANO|MVIMG)_(\d{8})_(\d{6})(?!\d)/, value: ([d, t]) => `${day8(d)}T${time6(t)}` },
  // Samsung: 20190601_123456.jpg.
  { match: /^(\d{8})_(\d{6})(?!\d)/, value: ([d, t]) => `${day8(d)}T${time6(t)}` },
  // Pixel: PXL_20190601_103456789.jpg, the time in UTC with milliseconds.
  { match: /^PXL_(\d{8})_(\d{6})\d{3}(?!\d)/, value: ([d, t]) => `${day8(d)}T${time6(t)}Z` },
  // WhatsApp: IMG-20190601-WA0001.jpg, the day it was sent or saved.
  { match: /^(?:IMG|VID|AUD|PTT)-(\d{8})-WA\d{4}/, value: ([d]) => day8(d) },
  // Signal: signal-2019-06-01-123456.jpg.
  { match: /^signal-(\d{4})-(\d{2})-(\d{2})-(\d{6})(?!\d)/, value: ([y, m, d, t]) => `${y}-${m}-${d}T${time6(t)}` },
  // Android screenshots: Screenshot_20190601-123456.png, and the older Screenshot_2019-06-01-12-34-56.png.
  { match: /^Screenshot_(\d{8})-(\d{6})(?!\d)/, value: ([d, t]) => `${day8(d)}T${time6(t)}` },
  { match: /^Screenshot_(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?!\d)/, value: ([y, m, d, h, i, s]) => `${y}-${m}-${d}T${h}:${i}:${s}` },
  // macOS screenshots: Screenshot 2019-06-01 at 12.34.56.png.
  { match: /^Screenshot (\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})(?!\d)/, value: ([y, m, d, h, i, s]) => `${y}-${m}-${d}T${h}:${i}:${s}` },
  // Desktop camera uploaders: 2019-06-01 12.34.56.jpg, or with an underscore, 2019-06-01_12.34.56.jpg,
  // and `-2` after the time when two shots share a second.
  { match: /^(\d{4})-(\d{2})-(\d{2})[ _](\d{2})\.(\d{2})\.(\d{2})(?!\d)/, value: ([y, m, d, h, i, s]) => `${y}-${m}-${d}T${h}:${i}:${s}` },
  // Saved from a browser or a chat app: image-20190601_123456.jpg, download_20190601_123456.jpeg.
  { match: /^(?:image-|download_)(\d{8})_(\d{6})(?!\d)/, value: ([d, t]) => `${day8(d)}T${time6(t)}` },
  // Facebook downloads: FB_IMG_1559385296000.jpg, epoch milliseconds.
  {
    match: /^FB_IMG_(\d{13})(?!\d)/,
    value: ([ms]) => new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  },
];

/**
 * The capture time file name `name` spells, or undefined when it spells none this module trusts.
 * Only the name is read: pass the last segment of a path.
 */
export const filenameDate = (name: string): string | undefined => {
  for (const pattern of PATTERNS) {
    const match = pattern.match.exec(name);
    if (!match) continue;
    const value = pattern.value(match.slice(1));
    const parts = parseCaptureTime(value);
    return parts && Number(parts.year) >= MIN_NAME_YEAR ? value : undefined;
  }
  return undefined;
};
