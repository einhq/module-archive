/**
 * Dating staged files again by their category's time rules (`staging retime`): each media
 * original's time-trust attrs (`digitized`, `whenName`) are set to what its category's rules give
 * it, and its capture time is resolved again where they changed. A file whose attrs already agree
 * is read and left alone, so a second run writes nothing.
 *
 * A page of files at a time, in a fixed number of store calls per page however many files it holds:
 * one query for the page, two child-link reads and one node read for the exif of the files whose
 * attrs change, and one batched write (`updateEach`). A device's clock is read once per call.
 */
import type { Command, NodeQueryCursor, NodeQueryEntry } from '@ein/client';
import { NOT_DERIVED, SYSTEM_TIME_ZONE } from '@ein/client';
import type { StagingRetimeAnswer, StagingTimeRules } from '@archive/staging/api';
import { type CaptureWhen, resolveTime, stampedSources, timeAttrs, whenFromExifAttrs } from '@archive/media/capture-resolve';
import { clockForFile, type DeviceClock, offsetAt } from '@archive/device/device-zone';
import { stampsHold, timeStamps } from '@archive/staging/category';

/** Files read per page. */
const PAGE = 500;

const MEDIA = /^(image|video|audio)\//;

/** Device clocks read so far, by `devicePath` (`''` for none). */
type Clocks = Map<string, Promise<DeviceClock>>;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A retime of `user`'s `path` that has done nothing yet. */
export const emptyRetime = (user: string, path: string, dryRun: boolean): StagingRetimeAnswer => ({
  ok: true,
  dryRun,
  user,
  path,
  scanned: 0,
  policyChanged: 0,
  retimed: 0,
  cleared: 0,
  bySource: {},
  failed: [],
});

/**
 * The normalized capture-time sources of each file in `ids` that has an exif node, by file id: two
 * child-link reads (`metadata`, then `exif`) and one node read for them all. A file with no exif
 * node is absent; one whose exif node predates `when` maps to undefined.
 */
const readWhens = async (cmd: Command, ids: string[]): Promise<Map<string, CaptureWhen | undefined>> => {
  const { vfs } = cmd.sys;
  const whens = new Map<string, CaptureWhen | undefined>();
  const metadataOf = new Map<string, string>();
  for (const [id, children] of await vfs.getChildLinksByIds(cmd.access, ids)) {
    const metadata = children.find((child) => child.name === 'metadata');
    if (metadata) metadataOf.set(metadata.id, id);
  }
  if (metadataOf.size === 0) return whens;
  const exifOf = new Map<string, string>();
  for (const [id, children] of await vfs.getChildLinksByIds(cmd.access, [...metadataOf.keys()])) {
    const exif = children.find((child) => child.name === 'exif');
    if (exif) exifOf.set(exif.id, metadataOf.get(id)!);
  }
  if (exifOf.size === 0) return whens;
  for (const [id, node] of await vfs.getNodesByIds(cmd.access, [...exifOf.keys()])) {
    whens.set(exifOf.get(id)!, whenFromExifAttrs(node.attrs as Record<string, unknown>));
  }
  return whens;
};

/** One page of files, retimed by `rules` into `answer`. */
const retimePage = async (cmd: Command, rows: NodeQueryEntry[], rules: StagingTimeRules, answer: StagingRetimeAnswer, clocks: Clocks): Promise<void> => {
  const due = rows.flatMap((row) => {
    const attrs = row.node.attrs as Record<string, unknown>;
    if (row.node.type !== 'file' || attrs.sourceId != null || !MEDIA.test(str(attrs.mimetype) ?? '')) return [];
    answer.scanned++;
    const stamps = timeStamps(rules, nameOf(row.absPath));
    return stampsHold(attrs, stamps) ? [] : [{ row, attrs, stamps }];
  });
  answer.policyChanged += due.length;
  if (due.length === 0) return;

  const whens = await readWhens(cmd, due.map(({ row }) => row.id));
  const changes: { path: string; attrs: Record<string, unknown> }[] = [];
  for (const { row, attrs, stamps } of due) {
    const change: Record<string, unknown> = { ...stamps };
    // No exif node: not indexed yet, and dated by what else it has, as `applyFileTime` dates it.
    // An exif node from before `when` says nothing, and the time is left as it is.
    const when = whens.has(row.id) ? whens.get(row.id) : {};
    if (when !== undefined) {
      const devicePath = str(attrs.devicePath) ?? '';
      if (!clocks.has(devicePath)) clocks.set(devicePath, clockForFile(cmd, devicePath || undefined));
      const clock = await clocks.get(devicePath)!;
      const resolved = resolveTime({
        manual: str(attrs.whenManual),
        gps: when.gps,
        device: when.device,
        digitizer: clock.digitizer,
        quicktimeUtc: clock.quicktimeUtc,
        deviceOffsetAt: (wallClock) => offsetAt(clock, wallClock, SYSTEM_TIME_ZONE),
        archiveZone: SYSTEM_TIME_ZONE,
        ...stampedSources(stamps),
      });
      const same = str(attrs.takenAt) === resolved?.takenAt && str(attrs.takenAtUtc) === resolved?.takenAtUtc &&
        str(attrs.takenAtSource) === resolved?.takenAtSource;
      if (!same) {
        Object.assign(change, timeAttrs(resolved));
        answer.retimed++;
        if (resolved) answer.bySource[resolved.takenAtSource] = (answer.bySource[resolved.takenAtSource] ?? 0) + 1;
        else answer.cleared++;
      }
    }
    changes.push({ path: row.absPath, attrs: change });
  }
  if (answer.dryRun) return;

  const written = await cmd.sys.vfs.updateEach(cmd.access, changes.map((change) => ({ ref: change.path, attrs: change.attrs })));
  written.forEach((result, i) => {
    if (result.status === 'fulfilled') return;
    answer.ok = false;
    answer.failed.push({ path: changes[i].path, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
};

/**
 * Date the staged media originals at `path` (a file) or within it (a directory) again by `rules`,
 * counting into `answer`; with `answer.dryRun` nothing is written. `clocks` lets several calls
 * share the device clocks they read.
 */
export const retimeScope = async (cmd: Command, path: string, rules: StagingTimeRules, answer: StagingRetimeAnswer, clocks: Clocks = new Map()): Promise<void> => {
  const { vfs } = cmd.sys;
  const node = await vfs.get(cmd.access, path);
  if (node.type === 'file') {
    await retimePage(cmd, [{ id: node.id, absPath: path, node, sortValue: null }], rules, answer, clocks);
    return;
  }
  let after: NodeQueryCursor | undefined;
  for (;;) {
    const rows = await vfs.query(cmd.access, { within: path, types: ['file'], where: [NOT_DERIVED], ...(after ? { after } : {}), limit: PAGE });
    await retimePage(cmd, rows, rules, answer, clocks);
    // Fewer than a page means none are left.
    if (rows.length < PAGE) return;
    after = { value: null, id: rows[rows.length - 1].id };
  }
};
