/**
 * Staged outputs: the hidden temp nodes a derivative is written into before it is renamed over
 * its final path.
 *
 * A step removes its own temps when it ends, but a step that never ends — a restart, an OOM
 * kill — leaves them behind. Each step therefore sweeps its output directory first, removing
 * temps of its kind old enough that no running step can still own them.
 */
import type { Command } from '@ein/client';

/**
 * How old a temp has to be before a sweep removes it: far beyond the longest step, a windowed
 * CPU encode included, so a temp a concurrent step is still writing is never taken.
 */
export const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/** Remove the node at `path` if there is one; a failure is ignored. */
export const removeNode = async (cmd: Command, path: string, parent: string): Promise<void> => {
  if (await cmd.sys.vfs.exists(cmd.access, path).catch(() => false)) {
    await cmd.sys.vfs.unlink(cmd.access, path, parent, { recursive: true }).catch(() => false);
  }
};

/**
 * Remove the temps in `dir` whose names start with `prefix` and that were created more than
 * `STALE_TEMP_MS` before `now`. A directory that cannot be listed is left alone.
 *
 * @returns the names removed.
 */
export const sweepStaleTemps = async (cmd: Command, dir: string, prefix: string, now = Date.now()): Promise<string[]> => {
  let children;
  try {
    children = await cmd.sys.vfs.children(cmd.access, dir);
  } catch {
    return [];
  }
  const stale = children.filter((child) => child.name.startsWith(prefix) && now - child.node.props.birthtime.timestamp > STALE_TEMP_MS);
  for (const child of stale) await removeNode(cmd, `${dir}/${child.name}`, dir);
  return stale.map((child) => child.name);
};

/** Reconcile bytes EMS wrote into the node at `path`, rejecting a successful empty write. */
export const syncNonEmpty = async (cmd: Command, path: string, label: string): Promise<void> => {
  const stat = await cmd.sys.vfs.statX(cmd.access, path) as { size?: number; sha256?: string; mimetype?: string };
  if (!(Number(stat.size) > 0)) throw new Error(`${label} wrote no bytes`);
  await cmd.sys.vfs.update(cmd.access, path, {
    attrs: { size: stat.size, sha256: stat.sha256, mimetype: stat.mimetype },
  });
};
