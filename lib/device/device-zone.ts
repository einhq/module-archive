/**
 * What a camera's clock was set to, at the moment it took a particular photograph.
 *
 * A camera clock is a bare wall reading: `2015:07:25 14:03:11`, and nothing about which
 * meridian that was said on. Turning it into an instant needs an offset from somewhere, and
 * this is where that somewhere lives. Two sources, in order:
 *
 * 1. **`DeviceAttrs.timezone`**, an IANA id. Better than an offset because it *is* the rule
 *    rather than one evaluation of it — summer and winter both come out right, for the year the
 *    photograph was taken rather than for this one.
 * 2. **The `configuration` log child**: `{utcOffset, autoDst}` entries, the first backdated to
 *    the epoch. A log rather than an attr because a camera that crossed an ocean has a history
 *    and not a setting, and `device-update` appends to it.
 *
 * ein/core#100.
 */

import type { Command, ResourceHandleIf } from '@ein/client';

/** One `configuration` entry: what the camera's clock was set to, from a given moment. */
type ClockSetting = {
  /** When this setting took effect, epoch ms. The importer backdates the first to 0. */
  from: number;
  /** Seconds east of UTC, in the sense `utc = wallClock - utcOffset`. */
  utcOffset: number;
  /** Whether the camera advanced itself for summer time. */
  autoDst: boolean;
};

/** Everything known about one device's clock. */
export type DeviceClock = {
  /** IANA id, when the device has one. Consulted first, because it knows the DST rule. */
  timezone?: string;
  /** Configuration history, oldest first. */
  history: ClockSetting[];
  /**
   * A scanner or an editor, whose clock records when the file was made rather than when the
   * photograph was taken. Carried here rather than looked up separately because it comes off
   * the same node read, and because a digitizer's device date must be suppressed by exactly
   * the thing that resolves a device's time.
   */
  digitizer?: boolean;
  /** The device keeps a container's `CreateDate` in UTC; read off the same node for the same reason. */
  quicktimeUtc?: boolean;
};

/** The log handle's timestamped reader. Structural, because a module cannot import LogHandle. */
type LogReadingHandle = ResourceHandleIf & {
  readEntries?: (size: number) => Promise<{ createdAt: Date; data: unknown }[]>;
};

/**
 * How many configuration entries to read.
 *
 * A device's clock settings change when somebody edits them, which is a handful of times in a
 * camera's life. Reading from the start rather than seeking to the tail is deliberate: the
 * *oldest* entries are the ones that date the oldest photographs, so a tail read would answer
 * the wrong question on a device with a long history.
 */
const CONFIG_LIMIT = 200;

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Read a device node's clock history. Returns an empty clock for a device that has none. */
const readDeviceClock = async (cmd: Command, devicePath: string): Promise<DeviceClock> => {
  const clock: DeviceClock = { history: [] };

  try {
    const node = await cmd.sys.vfs.get(cmd.access, devicePath);
    const attrs = node.attrs as { timezone?: unknown; digitizer?: unknown; quicktimeUtc?: unknown };
    if (typeof attrs.timezone === 'string' && attrs.timezone !== '') clock.timezone = attrs.timezone;
    if (attrs.digitizer === true) clock.digitizer = true;
    if (attrs.quicktimeUtc === true) clock.quicktimeUtc = true;
  } catch {
    // No such device. The caller falls back to the archive zone, which is what an unregistered
    // camera already got.
    return clock;
  }

  let handle: LogReadingHandle;
  try {
    handle = await cmd.sys.vfs.open(cmd.access, `${devicePath}/configuration`, { mode: 'r' }) as LogReadingHandle;
  } catch {
    return clock;
  }

  try {
    if (typeof handle.readEntries !== 'function') return clock;
    const entries = await handle.readEntries(CONFIG_LIMIT);
    for (const entry of entries) {
      const data = entry.data as { utcOffset?: unknown; autoDst?: unknown } | null;
      const utcOffset = num(data?.utcOffset);
      if (utcOffset === undefined) continue;
      clock.history.push({ from: entry.createdAt.getTime(), utcOffset, autoDst: data?.autoDst === true });
    }
    clock.history.sort((a, b) => a.from - b.from);
  } catch {
    // A truncated log is not a reason to date every one of this camera's photographs wrongly;
    // fall through to whatever the timezone attr said.
  } finally {
    await handle.close();
  }

  return clock;
};

/** Whether a wall clock falls in summer time for a zone — only asked when `autoDst` is set. */
const isDst = (wallClock: string, zone: string): boolean => {
  try {
    const at = Temporal.PlainDateTime.from(wallClock);
    const here = at.toZonedDateTime(zone).offsetNanoseconds;
    const january = at.with({ month: 1, day: 1 }).toZonedDateTime(zone).offsetNanoseconds;
    const july = at.with({ month: 7, day: 1 }).toZonedDateTime(zone).offsetNanoseconds;
    return here > Math.min(january, july);
  } catch {
    return false;
  }
};

/**
 * The offset, in seconds, this device's clock was on at a given wall clock — or undefined when
 * the registry has nothing to say and the caller should fall back to the archive's own zone.
 *
 * `archiveZone` is only used to evaluate `autoDst`, and only for a device configured with a
 * fixed offset *and* that flag. Anything with a real IANA zone never reaches it.
 */
export const offsetAt = (clock: DeviceClock, wallClock: string, archiveZone: string): number | undefined => {
  if (clock.timezone) {
    try {
      return Temporal.PlainDateTime.from(wallClock).toZonedDateTime(clock.timezone).offsetNanoseconds / 1e9;
    } catch {
      // An id the platform does not know. Fall through to the configuration log.
    }
  }

  if (clock.history.length === 0) return undefined;

  // Which setting was in force. The wall clock is read as if it were UTC purely to pick an
  // entry: configuration changes are years apart and an offset's worth of error cannot select
  // the wrong one.
  let at: number;
  try {
    at = Temporal.PlainDateTime.from(wallClock).toZonedDateTime('UTC').epochMilliseconds;
  } catch {
    return undefined;
  }

  let setting = clock.history[0];
  for (const candidate of clock.history) {
    if (candidate.from <= at) setting = candidate;
  }

  return setting.utcOffset + (setting.autoDst && isDst(wallClock, archiveZone) ? 3600 : 0);
};

/** A clock nothing is known about — what a file with no device link resolves against. */
export const NO_DEVICE_CLOCK: DeviceClock = { history: [] };

/**
 * The clock a file's device was keeping, or `NO_DEVICE_CLOCK` when it has no device link.
 *
 * One node read plus one log read per device. The common case for a scan or an upload is no
 * link at all, which costs neither.
 */
export const clockForFile = async (cmd: Command, devicePath: string | undefined): Promise<DeviceClock> =>
  devicePath ? await readDeviceClock(cmd, devicePath) : NO_DEVICE_CLOCK;
