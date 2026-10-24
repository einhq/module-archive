/**
 * Reading many nodes by path at once: each directory the paths lie in resolved once, then one read
 * of those directories' child edges and one of the nodes they lead to.
 */
import type { Command, Node } from '@ein/client';
import { basename, dirname } from '@std/path';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/**
 * The node id at each of `paths`, by the edge that names it, so a softlink is itself and not what
 * it points to. A path with nothing at it, or in a directory the reader cannot resolve, is absent.
 */
export const idsAt = async (vfs: Vfs, access: Access, paths: string[]): Promise<Map<string, string>> => {
  const dirs = new Map<string, string>();
  for (const dir of new Set(paths.map((path) => dirname(path)))) {
    const node = await vfs.get(access, dir).catch(() => undefined);
    if (node) dirs.set(dir, node.id);
  }
  const ids = new Map<string, string>();
  if (dirs.size === 0) return ids;
  const edges = await vfs.getChildLinksByIds(access, [...dirs.values()]);
  const byName = new Map([...edges].map(([dirId, links]) => [dirId, new Map(links.map((link) => [link.name, link.id]))]));
  for (const path of paths) {
    const dirId = dirs.get(dirname(path));
    const id = dirId === undefined ? undefined : byName.get(dirId)?.get(basename(path));
    if (id) ids.set(path, id);
  }
  return ids;
};

/** The node at each of `paths`, as `idsAt` finds it and the reader may read it; others are absent. */
export const nodesAt = async (vfs: Vfs, access: Access, paths: string[]): Promise<Map<string, Node>> => {
  const ids = await idsAt(vfs, access, paths);
  const nodes = ids.size > 0 ? await vfs.getNodesByIds(access, [...new Set(ids.values())]) : new Map<string, Node>();
  return new Map([...ids].flatMap(([path, id]) => {
    const node = nodes.get(id);
    return node ? [[path, node] as const] : [];
  }));
};
