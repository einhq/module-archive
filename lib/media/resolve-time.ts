/**
 * Resolving one media file's capture time from everything the archive knows about it.
 *
 * The rules themselves are `./capture-resolve.ts`; what lives here is the part that is about a
 * *media file*: where its exif sits, its paired sidecar, which device it is linked to, and
 * writing the answer back.
 */

import type { Command } from '@ein/client';
import { SYSTEM_TIME_ZONE } from '@ein/client';
import { resolveTime, stampedSources, timeAttrs, whenFromExifAttrs } from '@archive/media/capture-resolve';
import type { CaptureWhen, ResolvedTime } from '@archive/media/capture-resolve';
import { clockForFile, type DeviceClock, offsetAt } from '@archive/device/device-zone';
import { readSidecar, sidecarTime } from '@archive/media/paired-sidecar';

/* ------------------------------------------------------------------ */
/* Resolving a file that already exists                                */
/* ------------------------------------------------------------------ */

/**
 * The normalized capture-time sources stored on a file's exif child.
 *
 * Reads `metadata/exif.when` rather than the raw exiftool record: the hard part — which tag is
 * a capture time at all — is `@archive/media/exif-date`'s and was decided at index time. Re-resolving a
 * file therefore costs one node read and never exiftool, which is what lets a whole-corpus pass
 * run in a single sweep (`media-resolve-time`).
 */
const readExifWhen = async (cmd: Command, filePath: string): Promise<CaptureWhen | undefined> => {
  try {
    const exif = await cmd.sys.vfs.get(cmd.access, `${filePath}/metadata/exif`);
    return whenFromExifAttrs(exif.attrs as Record<string, unknown>);
  } catch {
    // Not indexed yet. A manual time still resolves, which is what the legacy import relies on:
    // the media crawl is a years-long backlog and a hand-typed date must not wait for it.
    return {};
  }
};

type FileTimeOverrides = {
  /**
   * The manual time to resolve with, instead of whatever the node currently carries. `null`
   * clears it. Lets `file-set-time` resolve and write in one update rather than write, re-read
   * and write again.
   */
  manual?: string | null;
};

/** The clocks of the devices read so far, so files of one device read its clock once. */
type DeviceClocks = Map<string, Promise<DeviceClock>>;

/**
 * Resolve one existing file's capture time from everything the archive knows about it.
 *
 * The single entry point for every writer that is not `exif-extract` — which has all of this in
 * hand already and would only be re-reading its own work.
 */
const resolveFileTime = async (
  cmd: Command,
  filePath: string,
  overrides: FileTimeOverrides = {},
  clocks: DeviceClocks = new Map(),
): Promise<ResolvedTime | null> => {
  const node = await cmd.sys.vfs.get(cmd.access, filePath);
  const attrs = node.attrs as Record<string, unknown>;

  const stored = typeof attrs.whenManual === 'string' ? attrs.whenManual : undefined;
  const manual = overrides.manual === null ? undefined : overrides.manual ?? stored;

  const devicePath = typeof attrs.devicePath === 'string' ? attrs.devicePath : undefined;
  if (devicePath !== undefined && !clocks.has(devicePath)) clocks.set(devicePath, clockForFile(cmd, devicePath));
  const clock = devicePath === undefined ? await clockForFile(cmd, undefined) : await clocks.get(devicePath)!;
  const when = await readExifWhen(cmd, filePath);
  const sidecar = sidecarTime(await readSidecar(cmd.sys.vfs, cmd.access, filePath));

  return resolveTime({
    manual,
    gps: when?.gps,
    device: when?.device,
    digitizer: clock.digitizer,
    quicktimeUtc: clock.quicktimeUtc,
    deviceOffsetAt: (wallClock) => offsetAt(clock, wallClock, SYSTEM_TIME_ZONE),
    archiveZone: SYSTEM_TIME_ZONE,
    ...stampedSources(attrs),
    ...(sidecar ? { sidecar } : {}),
  });
};

/**
 * Resolve and write a file's capture time. Returns what it wrote, or null when the file has no
 * believable date — in which case the three attrs are cleared rather than left stale.
 */
export const applyFileTime = async (
  cmd: Command,
  filePath: string,
  overrides: FileTimeOverrides = {},
): Promise<ResolvedTime | null> => {
  const resolved = await resolveFileTime(cmd, filePath, overrides);
  await cmd.sys.vfs.update(cmd.access, filePath, { attrs: timeAttrs(resolved) });
  return resolved;
};

/** One file's new hand-typed time (null clears it), and other attrs written with it. */
type FileTimeChange = { path: string; manual: string | null; attrs?: Record<string, unknown> };

/**
 * Give many files a hand-typed time: every file's time is resolved first, so a file that cannot
 * be read throws before anything is written; then each file's manual time, its `attrs` and its
 * resolution are written in one `updateEach`, a store write per batch of files rather than per
 * file. A file the write refuses fails alone.
 *
 * @returns per change, in order, what was written or why the write was refused.
 */
export const applyFileTimes = async (cmd: Command, changes: FileTimeChange[]): Promise<PromiseSettledResult<ResolvedTime | null>[]> => {
  const clocks: DeviceClocks = new Map();
  const resolved: (ResolvedTime | null)[] = [];
  for (const change of changes) {
    try {
      resolved.push(await resolveFileTime(cmd, change.path, { manual: change.manual }, clocks));
    } catch (error) {
      throw new Error(`${change.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const written = await cmd.sys.vfs.updateEach(
    cmd.access,
    changes.map((change, i) => ({ ref: change.path, attrs: { whenManual: change.manual, ...change.attrs, ...timeAttrs(resolved[i]) } })),
  );
  return written.map((result, i) => result.status === 'rejected' ? result : { status: 'fulfilled', value: resolved[i] });
};
