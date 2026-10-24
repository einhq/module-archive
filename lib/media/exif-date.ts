/**
 * Choosing which exiftool date tag is a capture time, turning it into date parts, and those
 * parts into a timestamp.
 *
 * Split out of `exif-extract` because the interesting part is what it *rejects*, and that
 * is worth testing without exiftool in the loop. A camera whose clock was never set does
 * not omit the tag — it writes a sentinel, `0000:00:00 00:00:00` being the common one —
 * and since missing components are filled with defaults, parsing it naively gives a
 * well-formed `0000-00-00T00:00:00`. That is worse than no date: a file without `takenAt`
 * drops out of ordered queries, while a zeroed one sorts first everywhere and reads as
 * real. No date is the honest answer, so a tag that cannot be a capture time yields null
 * here and the caller writes nothing.
 *
 * The same argument decides *which tag* to believe, and it is the reason `pickCaptureDate`
 * exists. Only `DateTimeOriginal` means "when the photograph was taken". `CreateDate` is
 * EXIF DateTimeDigitized — "when this file was made" — which for a camera is the same
 * instant and for a scanner or an image editor is the scan or the save: trusting it would
 * date a scanned negative to the day it was digitised.
 */

export type ExifDateParts = {
  year?: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  timezone?: string;
  /** Read from a container's `CreateDate`, which a device may keep in UTC or in local time. */
  quicktime?: true;
};

/**
 * Earliest plausible capture date; the first surviving photograph is 1826.
 */
const MIN_YEAR = 1826;

/**
 * Zero-clock timestamps that are syntactically fine and semantically "never set". The
 * epochs are here because a device that loses power reports its clock's origin rather
 * than an error: 1970-01-01 for unix, 1904-01-01 for QuickTime.
 */
const SENTINELS = new Set([
  '0000:00:00 00:00:00',
  '1970:01:01 00:00:00',
  '1904:01:01 00:00:00',
]);

const PATTERN = /^(\d{4})[:/](\d{2})[:/](\d{2})\s(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?([-+Z].*)?$/;

/** Whether the components name a day that exists — catches 02-30 and month 00. */
function isRealDate(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Parse an exiftool date tag (`2015:07:25 14:03:11`, optionally with a fraction and a
 * zone) into its parts, or null when it is not a capture time we believe.
 */
export function parseExifDate(input: string): ExifDateParts | null {
  const m = input.trim().match(PATTERN);
  if (!m) return null;

  const [, year, month, day, hour, minute, second, timezone] = m;
  const sec = second ?? '00';

  if (SENTINELS.has(`${year}:${month}:${day} ${hour}:${minute}:${sec}`)) return null;

  const y = Number(year);
  if (y < MIN_YEAR || y > new Date().getUTCFullYear() + 1) return null;
  if (!isRealDate(y, Number(month), Number(day), Number(hour), Number(minute), Number(sec))) {
    return null;
  }

  const parts: ExifDateParts = { year, month, day, hour, minute };
  if (second) parts.second = second;
  if (timezone) parts.timezone = timezone === 'Z' ? '+00:00' : timezone;

  return parts;
}

/**
 * The wall clock these parts name. The resolver's (`./capture-resolve.ts`), which consumes it:
 * two spellings of "drop the offset and default the seconds" is one too many. Re-exported here
 * under the name this module's callers already use.
 */
export { partsToWallClock as exifPartsToWallClock } from './capture-resolve.ts';

/**
 * Tags a lens and a shutter produce, and nothing else does. Their presence is what
 * separates a still image that came out of a camera from one that came out of a scanner or
 * an editor, which matters because both write `CreateDate` and only the first means capture.
 * Scanners and editors write none of these, while a phone photo that lost its
 * `DateTimeOriginal` writes all of them.
 *
 * `ExifVersion` looks like it belongs here and does not: scanners write it too.
 */
const CAPTURE_EVIDENCE = [
  'FNumber',
  'ExposureTime',
  'ISO',
  'FocalLength',
  'SubSecTimeOriginal',
  'ShutterSpeedValue',
  'ApertureValue',
  'MaxApertureValue',
  'ExposureProgram',
  'MeteringMode',
  'Flash',
  'LensModel',
  'LensInfo',
];

/** Whether the tags say a camera exposed this frame. */
function hasCaptureEvidence(raw: Record<string, unknown>): boolean {
  return CAPTURE_EVIDENCE.some((tag) => raw[tag] !== undefined && raw[tag] !== null);
}

/** The capture time and the tag it came from, so a verbose run can say what it believed. */
type CaptureDate = { parts: ExifDateParts; source: string };

const tag = (raw: Record<string, unknown>, key: string): string => {
  const value = raw[key];
  return value === null || value === undefined ? '' : String(value);
};

/**
 * Keys only Android's recorder writes into a container (`com.android.*`); a phone that writes
 * no `Make` still writes these.
 */
const ANDROID_KEYS = ['AndroidVersion', 'AndroidMake', 'AndroidModel', 'AndroidCaptureFPS'];

/**
 * Whether a container's `CreateDate` is UTC, as the QuickTime format defines it, rather than the
 * recorder's wall clock. Phones and ffmpeg keep to the format; many cameras write their local
 * clock there, and a file that does not say who wrote it is read that way too unless its device
 * is registered as keeping UTC (`quicktimeUtc`, ein/core#612).
 */
function writesUtc(raw: Record<string, unknown>, make: string): boolean {
  if (make === 'Apple') return true;
  if (ANDROID_KEYS.some((key) => raw[key] !== undefined && raw[key] !== null)) return true;
  return tag(raw, 'Encoder').startsWith('Lavf');
}

/**
 * The capture time from a whole exiftool record, or null when nothing in it is one.
 *
 * A container — video or audio — keeps the full chain: an MP4 or QuickTime `CreateDate` is
 * written by the recorder at the moment of recording, so it is a capture time in the way a
 * still image's is not, and it is usually the only date the file has. Apple videos put the
 * local wall clock in `CreationDate` and UTC in the rest, so that one comes first. A container
 * `CreateDate` comes back marked `quicktime`, and from a writer that keeps it in UTC
 * (`writesUtc`) with timezone `Z` as well.
 *
 * A still image is only believed on `DateTimeOriginal` unless the file also carries
 * `hasCaptureEvidence`. That gate is what keeps a flatbed's `ExifIFD:CreateDate` and
 * Photoshop's `XMP-xmp:CreateDate` out while still dating the phone photos whose
 * `DateTimeOriginal` an editor stripped.
 *
 * The first tag that is *present* decides; an unparseable value is not a reason to fall
 * through to the next, because a clock that wrote one sentinel wrote them all.
 */
export function pickCaptureDate(raw: Record<string, unknown>): CaptureDate | null {
  const mimetype = tag(raw, 'MIMEType');
  // Unknown mimetype is treated as a still image — the conservative side of the gate.
  const isContainer = mimetype.startsWith('video/') || mimetype.startsWith('audio/');
  const make = tag(raw, 'Make') || tag(raw, 'DeviceManufacturer');

  let order: string[];
  if (isContainer) {
    order = make === 'Apple' ? ['CreationDate', 'DateTimeOriginal', 'CreationDateValue', 'CreateDate'] : ['DateTimeOriginal', 'CreationDateValue', 'CreateDate'];
  } else {
    order = hasCaptureEvidence(raw) ? ['DateTimeOriginal', 'CreationDateValue', 'CreateDate'] : ['DateTimeOriginal'];
  }

  for (const name of order) {
    const value = tag(raw, name);
    if (!value) continue;
    const parts = parseExifDate(value);
    if (!parts) return null;
    if (isContainer && name === 'CreateDate') {
      parts.quicktime = true;
      if (writesUtc(raw, make)) parts.timezone = 'Z';
    }
    return { parts, source: name };
  }

  return null;
}
