/**
 * Whether the caller may keep what a processing command makes of a file or an album: its caption,
 * transcript, faces, vectors, renditions, all stored under it.
 */

import type { Command, NodeProps } from '@ein/client';
import { verifyAccess } from '@ein/client';

/**
 * Report that the caller may not write `path`. True means the caller should stop —
 * `if (await reportUnwritable(cmd, path, node)) return 1;`.
 *
 * Asked before the media service is: a write refused only afterwards would leave EMS's work spent
 * all the same, as often as anyone who may only read the file cared to ask — the guest, who never
 * writes, included (ein/core#535).
 */
export const reportUnwritable = async (cmd: Command, path: string, node: { props: NodeProps }): Promise<boolean> => {
  if (verifyAccess(cmd.access, node.props, 'w')) return false;
  await cmd.writeError(`${cmd.name}: ${path}: permission denied\n`);
  return true;
};
