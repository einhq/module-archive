/**
 * Choosing a file's capture time from the sources that claim to know it.
 *
 * A file can be told when it was taken by five different things, and they disagree in
 * characteristic ways:
 *
 * - **manual** — somebody typed it. Often all that exists for a scanned print, often no more
 *   precise than a year, and always right in the sense that matters: a person looked at the
 *   photograph and said so. It wins.
 * - **sidecar** — what the file's paired sidecar (`<file>/sidecar`) says. An XMP date
 *   (`photoshop:DateCreated`) is a person's date written by an editor, at its own precision, and
 *   comes next. A Google Photos Takeout gives an instant (`photoTakenTime`), which is Google's
 *   reading of the camera clock, or a person's date when they changed it there: more than 26
 *   hours from the camera clock, or from the upload with no camera clock, it is a person's and
 *   comes next too; within them it only says which offset the camera clock was in, and is used
 *   after the GPS fix. Within 26 hours of the upload with no camera clock, it is the upload, and
 *   never used.
 * - **gps** — the receiver's clock, disciplined by satellite. True UTC, full precision, and the
 *   only source that knows what instant it actually was. It wins over the device.
 * - **device** — the camera's own clock. A wall clock with no zone attached, frequently wrong
 *   by minutes and occasionally by years, but for most files it is all there is.
 * - **name** — a date the file's name spells (`whenName`), read only where its staging category
 *   says names are dates (`@archive/media/filename-date`). The last resort: a phone writes the
 *   same clock into the name as into the tags, so the name decides only when the tags are gone.
 *
 * A **digitized** file (`digitized`, stamped where a category holds scans) is a copy made long
 * after the picture: the device's clock, the GPS receiver's, the name, and a Takeout instant that
 * agrees with them all say when the copy was made, so none of them is believed, and only a
 * person's date is left: a manual one, an XMP one, or one changed in Google Photos.
 *
 * Two attrs come out, and the split is the point. `takenAt` is the **wall clock** — what the
 * clock on the wall said, at whatever precision is honest, stamped with an offset when one can
 * be established. `takenAtUtc` is the **instant**, always complete, always UTC, and it is what
 * sorts; `@ein/client`'s capture-time helpers handle the two.
 */

import { isCaptureTime, parseCaptureTime, toUtc, withOffset } from '@ein/client';

/**
 * The date components a source hands over: strings, because they come off an exiftool record
 * that way and because a missing one is absent rather than zero.
 *
 * Structurally the same as `@archive/media/exif-date`'s `ExifDateParts`, and declared here
 * rather than imported because the resolution rules are about clocks rather than about EXIF.
 */
export type CaptureDateParts = {
  year?: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  /**
   * The offset the reading was taken in. `Z` is a UTC reading from a device that keeps its clock
   * in UTC, which says nothing about the wall clock where it stood; `+00:00` is a wall clock in
   * that offset.
   */
  timezone?: string;
  /**
   * Read from a container's `CreateDate`. Without a timezone it is a wall clock unless the device
   * registry says the device keeps that tag in UTC (`quicktimeUtc`).
   */
  quicktime?: true;
};

/**
 * The **wall clock** these parts name: `YYYY-MM-DDTHH:MM:SS`, and nothing about which meridian
 * it was said on.
 *
 * The offset is deliberately left off even when the source carried one, because whether it
 * reaches `takenAt` is `resolveTime`'s decision — weighed against the GPS fix and the device
 * registry — and it can only decide that if it is handed the reading rather than a conclusion.
 * Appended at extraction time, it would also leak `+00:00` into an attr every range query
 * compares as bytes.
 */
export const partsToWallClock = (parts: CaptureDateParts): string =>
  `${parts.year}-${parts.month}-${parts.day}` +
  `T${parts.hour}:${parts.minute}:${parts.second ?? '00'}`;

type TimeSource = 'manual' | 'sidecar' | 'gps' | 'device' | 'name';

/**
 * The times a paired sidecar gives (`@archive/media/sidecars`): a wall clock an XMP packet states
 * (`wallClock`, a capture time at any precision), and a Takeout's capture instant and upload
 * instant (`instant`, `uploaded`, both `YYYY-MM-DDTHH:MM:SSZ`).
 */
export type SidecarTime = { wallClock?: string; instant?: string; uploaded?: string };

export type ResolvedTime = {
  /** Wall clock, precision = length, offset when known. The range and facet attr. */
  takenAt: string;
  /** `YYYY-MM-DDTHH:MM:SSZ`. The ordering and cursor attr. */
  takenAtUtc: string;
  takenAtSource: TimeSource;
};

type TimeSources = {
  /** The manual capture time, as stored in the file's `whenManual` attr. */
  manual?: string;
  gps?: CaptureDateParts;
  device?: CaptureDateParts;
  /**
   * The offset in seconds the device's clock was set to at a given wall clock, when the device
   * registry knows. `@archive/device/device-zone` builds this; the resolver only asks.
   */
  deviceOffsetAt?: (wallClock: string) => number | undefined;
  /**
   * The device is a scanner or an editor, so its clock records when the *file* was made.
   *
   * Some scanners write the scan time into `DateTimeOriginal` itself, which no
   * EXIF rule can catch — the registry's `digitizer` flag is the only thing that knows. The
   * device source is dropped entirely; a GPS date, if there is one, still stands.
   */
  digitizer?: boolean;
  /**
   * The device keeps a container's `CreateDate` in UTC, as the QuickTime format defines it, even
   * where the file does not say so: a `quicktime` reading with no timezone is then read as UTC.
   */
  quicktimeUtc?: boolean;
  /**
   * The file is a digitized copy, a scan: every clock recorded while digitizing (device, GPS and
   * name) is when the copy was made, and is dropped. A manual time still stands.
   */
  digitized?: boolean;
  /**
   * The capture time the file's name spells (`whenName`): a day, a wall clock, or a UTC reading
   * (`…Z`). Used only when nothing above it resolves.
   */
  name?: string;
  /** What the file's paired sidecar says of when it was taken. */
  sidecar?: SidecarTime;
  /** The archive's own zone, for a wall clock nothing else can place. */
  archiveZone: string;
};

/**
 * The furthest a GPS date and a device date may sit apart before the GPS date is disbelieved.
 *
 * 26 hours: the widest real UTC offset is +14:00, and a camera clock that has never been set
 * since a battery change can be several hours out on top of that. Anything beyond is not a
 * timezone and not drift: it is a **stale fix**, a receiver that never got a lock reporting the
 * last one it had, days old.
 */
const GPS_SANITY_WINDOW_SECONDS = 26 * 3600;

/** `YYYY-MM-DDTHH:MM:SSZ` as its parts, as a GPS reading gives them. */
const instantParts = (instant: string): CaptureDateParts | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(instant);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return { year, month, day, hour, minute, second, timezone: 'Z' };
};

/** Epoch seconds for a parts object read as if it were UTC — only ever used for differences. */
const partsToNaiveSeconds = (parts: CaptureDateParts): number =>
  Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second ?? '00'),
  ) / 1000;

type GpsVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a GPS date is worth believing.
 *
 * The cheap checks happen before this: `exif-extract` drops a fix with `GPSDOP === 0`, and
 * `@archive/media/exif-date` rejects the zero-clock sentinels (`0000:00:00`, the unix epoch, the
 * QuickTime epoch) for every source alike. What is left is the failure those two cannot see —
 * a syntactically perfect date from a receiver that was reporting an old fix — and the only
 * evidence for it is the camera's own clock sitting somewhere else entirely.
 *
 * With no device date there is nothing to check against, and the GPS date is taken as read.
 *
 * Deliberately **not** checked: the 1024-week GPS rollover, which shifts a receiver's date by
 * about 19.7 years. No file in the archive shows it, and a speculative check on a date this
 * system otherwise believes would throw away good dates for a fault nobody here has.
 */
export const isValidGpsDate = (gps: CaptureDateParts, device?: CaptureDateParts): GpsVerdict => {
  if (!device) return { ok: true };

  const delta = partsToNaiveSeconds(gps) - partsToNaiveSeconds(device);
  if (Math.abs(delta) > GPS_SANITY_WINDOW_SECONDS) {
    const hours = (delta / 3600).toFixed(1);
    return { ok: false, reason: `gps date is ${hours}h from the device clock (stale fix?)` };
  }
  return { ok: true };
};

/**
 * The UTC offset the camera was standing in, recovered from the pair of dates.
 *
 * `device − gps` is the offset plus the camera's clock error, and rounding to the hour
 * separates them: real offsets are whole hours here, and the residue is drift — +1 h 15 m is
 * not a timezone but a camera running a quarter of an hour fast.
 *
 * The half-hour and three-quarter-hour zones (India, Nepal, Chatham) would be rounded away by
 * this. Guessing a 45-minute offset out of a signal that also
 * contains clock drift would be inventing precision — the wall clock is still the camera's own
 * either way, so only the stamped offset is affected.
 */
export const recoverOffsetSeconds = (device: CaptureDateParts, gps: CaptureDateParts): number =>
  Math.round((partsToNaiveSeconds(device) - partsToNaiveSeconds(gps)) / 3600) * 3600;

/**
 * A UTC device reading (`timezone: 'Z'`) restated as the wall clock where the device stood, with
 * its offset: the device registry's, else the archive zone's at that instant. Any other reading
 * is returned as it is.
 */
const placeUtcReading = (
  device: CaptureDateParts,
  deviceOffsetAt: TimeSources['deviceOffsetAt'],
  archiveZone: string,
): CaptureDateParts | undefined => {
  if (device.timezone !== 'Z') return device;
  try {
    const utc = Temporal.PlainDateTime.from(partsToWallClock(device));
    const local = (offset: number) => utc.add({ seconds: offset }).toString({ smallestUnit: 'second' });
    // The registry answers for a wall clock, which is what is being sought: asked first at the UTC
    // reading, then again at the wall clock that gives, which settles it unless a zone changed
    // its offset in between.
    const guess = deviceOffsetAt?.(local(0));
    const offset = guess !== undefined
      ? deviceOffsetAt?.(local(guess)) ?? guess
      : Temporal.Instant.from(`${local(0)}Z`).toZonedDateTimeISO(archiveZone).offsetNanoseconds / 1e9;
    const stamped = withOffset(local(offset), offset);
    const [date, time] = stamped.slice(0, 19).split('T');
    const [year, month, day] = date.split('-');
    const [hour, minute, second] = time.split(':');
    return { year, month, day, hour, minute, second, timezone: stamped.slice(19) };
  } catch {
    // An unknown archive zone or a wall clock Temporal refuses: no date, as `toUtc` gives then.
    return undefined;
  }
};

/**
 * Resolve the sources into the pair of attrs the file node carries.
 *
 * Returns null when nothing usable is left — which is a result, not a failure. A file with no
 * believable date is absent from time-ordered queries, and that is the honest location for it;
 * `exif-extract` writes nulls so a re-resolve can take a wrong date back off.
 */
export const resolveTime = (sources: TimeSources): ResolvedTime | null => {
  const { manual, archiveZone } = sources;
  const given = sources.device?.quicktime && sources.device.timezone === undefined && sources.quicktimeUtc ? { ...sources.device, timezone: 'Z' } : sources.device;
  const reading = given && placeUtcReading(given, sources.deviceOffsetAt, archiveZone);
  const device = sources.digitizer || sources.digitized ? undefined : reading;

  // manual wins outright: a person looked at the photograph.
  if (manual !== undefined && isCaptureTime(manual)) {
    const takenAtUtc = toUtc(manual, archiveZone);
    if (takenAtUtc) return { takenAt: manual, takenAtUtc, takenAtSource: 'manual' };
  }

  // A date an editor wrote into the sidecar is a person's too, at the precision they gave it.
  if (sources.sidecar?.wallClock !== undefined) {
    const stated = resolveWallClock(sources.sidecar.wallClock, sources.deviceOffsetAt, archiveZone);
    if (stated) return { ...stated, takenAtSource: 'sidecar' };
  }

  // A Takeout instant far from the camera clock (unsuppressed: a digitizer's clock is still a
  // clock), or with none far from the upload, is a date a person set in Google Photos.
  const instant = sources.sidecar?.instant !== undefined ? instantParts(sources.sidecar.instant) : undefined;
  const uploaded = sources.sidecar?.uploaded !== undefined ? instantParts(sources.sidecar.uploaded) : undefined;
  const farFrom = (other: CaptureDateParts) => Math.abs(partsToNaiveSeconds(instant!) - partsToNaiveSeconds(other)) > GPS_SANITY_WINDOW_SECONDS;
  if (instant && (reading ? farFrom(reading) : !uploaded || farFrom(uploaded))) {
    return { takenAt: sources.sidecar!.instant!, takenAtUtc: sources.sidecar!.instant!, takenAtSource: 'sidecar' };
  }

  // Cross-checked against the *unsuppressed* device date: a digitizer's clock is the wrong
  // time but it is still a clock, and a fix two days off one is two days off either way.
  const gps = !sources.digitized && sources.gps && isValidGpsDate(sources.gps, reading).ok ? sources.gps : undefined;

  if (gps) {
    const takenAtUtc = toUtc(`${partsToWallClock(gps)}Z`, archiveZone);
    if (takenAtUtc) {
      // The instant is the GPS receiver's. The wall clock is the camera's, because that is the
      // clock the photographer was reading — and the difference between the two is what says
      // which offset to stamp it with. Without a device date there is nothing to display but
      // the UTC reading itself.
      const takenAt = device ? withOffset(partsToWallClock(device), recoverOffsetSeconds(device, gps)) : `${partsToWallClock(gps)}Z`;
      return { takenAt, takenAtUtc, takenAtSource: 'gps' };
    }
  }

  // A Takeout instant near the camera clock is the instant the camera clock names: the wall clock
  // stays the camera's, the instant is Google's, and the two say which offset to stamp. A camera
  // that recorded its own offset already says all of it.
  if (instant && device && device.timezone === undefined) {
    return { takenAt: withOffset(partsToWallClock(device), recoverOffsetSeconds(device, instant)), takenAtUtc: sources.sidecar!.instant!, takenAtSource: 'sidecar' };
  }

  if (device) {
    const wallClock = partsToWallClock(device);
    // An offset the camera itself recorded outranks anything the registry believes about it.
    const explicit = device.timezone;
    const registry = sources.deviceOffsetAt?.(wallClock);
    const takenAt = explicit !== undefined ? `${wallClock}${explicit}` : registry !== undefined ? withOffset(wallClock, registry) : wallClock;
    const takenAtUtc = toUtc(takenAt, archiveZone);
    if (takenAtUtc) return { takenAt, takenAtUtc, takenAtSource: 'device' };
  }

  if (sources.name !== undefined && !sources.digitized) {
    const named = resolveName(sources.name, sources.deviceOffsetAt, archiveZone);
    if (named) return { ...named, takenAtSource: 'name' };
  }

  return null;
};

/**
 * A wall clock a person stated (an XMP date) as the pair of attrs: with its own offset as it is;
 * otherwise as a name's is read, a minute or second taking the device registry's offset, else the
 * archive's zone, and a coarser one staying as precise as it is.
 */
const resolveWallClock = (value: string, deviceOffsetAt: TimeSources['deviceOffsetAt'], archiveZone: string): Omit<ResolvedTime, 'takenAtSource'> | undefined => {
  if (parseCaptureTime(value)?.offset === undefined) return resolveName(value, deviceOffsetAt, archiveZone);
  const takenAtUtc = toUtc(value, archiveZone);
  return takenAtUtc ? { takenAt: value, takenAtUtc } : undefined;
};

/**
 * A name's capture time as the pair of attrs. A UTC reading is placed on the wall clock where the
 * device stood, as a UTC device reading is; a wall clock takes the device registry's offset when
 * it knows one, and is otherwise read in the archive's zone, as the camera clock is; a day stays
 * a day.
 */
const resolveName = (name: string, deviceOffsetAt: TimeSources['deviceOffsetAt'], archiveZone: string): Omit<ResolvedTime, 'takenAtSource'> | undefined => {
  const parts = parseCaptureTime(name);
  if (!parts) return undefined;
  if (parts.precision !== 'second' && parts.precision !== 'minute') {
    const takenAtUtc = toUtc(name, archiveZone);
    return takenAtUtc ? { takenAt: name, takenAtUtc } : undefined;
  }
  const wall = { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
  if (name.endsWith('Z')) {
    const placed = placeUtcReading({ ...wall, timezone: 'Z' }, deviceOffsetAt, archiveZone);
    const takenAtUtc = toUtc(name, archiveZone);
    return placed && takenAtUtc ? { takenAt: `${partsToWallClock(placed)}${placed.timezone ?? ''}`, takenAtUtc } : undefined;
  }
  const wallClock = partsToWallClock(wall);
  const registry = deviceOffsetAt?.(wallClock);
  const takenAt = registry !== undefined ? withOffset(wallClock, registry) : wallClock;
  const takenAtUtc = toUtc(takenAt, archiveZone);
  return takenAtUtc ? { takenAt, takenAtUtc } : undefined;
};

/**
 * The time-trust inputs a file carries, as `resolveTime` takes them: `digitized: true` and a
 * `whenName` that is a capture time. Anything else there is no input.
 */
export const stampedSources = (attrs: Record<string, unknown>): { digitized?: boolean; name?: string } => ({
  ...(attrs.digitized === true ? { digitized: true } : {}),
  ...(typeof attrs.whenName === 'string' && isCaptureTime(attrs.whenName) ? { name: attrs.whenName } : {}),
});

/** The three attrs, or three nulls — the shape `vfs.update` wants either way. */
export const timeAttrs = (resolved: ResolvedTime | null): Record<string, unknown> => ({
  takenAt: resolved?.takenAt ?? null,
  takenAtUtc: resolved?.takenAtUtc ?? null,
  takenAtSource: resolved?.takenAtSource ?? null,
});

/** The `when` block `exif-extract` normalizes onto a file's `metadata/exif` child. */
export type CaptureWhen = { device?: CaptureDateParts; gps?: CaptureDateParts };

const isParts = (value: unknown): value is CaptureDateParts => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const parts = value as CaptureDateParts;
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute]
    .every((part) => typeof part === 'string' && part !== '');
};

/**
 * Pull the normalized capture-time sources out of an exif node's attrs.
 *
 * Reads `when` rather than the raw exiftool record: the hard part — which tag is a capture time
 * at all — was decided at index time and is `@archive/media/exif-date`'s call, not this one's. That is
 * what lets a whole-corpus re-resolution run without ever spawning exiftool.
 *
 * **`undefined` and `{}` mean different things, and the difference is load-bearing.** An exif
 * node with no `when` key at all says nothing — re-resolving such a file must leave its date
 * alone rather than clear it.
 * A `when` that is present and holds no usable date is a positive statement that this file has
 * none, and clearing is then the right answer.
 *
 * Anything malformed inside a present `when` yields an empty result rather than a partial one.
 * A half-read `when` would silently demote a GPS-dated file to its camera clock, which looks
 * exactly like a working answer.
 */
export const whenFromExifAttrs = (attrs: Record<string, unknown>): CaptureWhen | undefined => {
  if (!Object.hasOwn(attrs, 'when')) return undefined;
  const when = attrs.when;
  if (when === null || typeof when !== 'object' || Array.isArray(when)) return {};
  const { device, gps } = when as { device?: unknown; gps?: unknown };
  return { device: isParts(device) ? device : undefined, gps: isParts(gps) ? gps : undefined };
};
