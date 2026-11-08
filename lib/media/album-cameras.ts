/**
 * An album's cameras: the ones whose tracks its map draws.
 *
 * - The cameras that took its media are on the list, read from the members' `cameraPath` each time
 *   it is asked, so media from a new camera joining, or a member linked to its camera later, is
 *   on it at once — and so is a track that camera records later.
 * - A camera added by hand is a softlink in the album's `cameras/` directory, named by the
 *   camera's slug: `<album>/cameras/<slug>` → `/archive/cameras/<slug>`.
 * - A camera that took some of its media and was removed from the list is named in the album's
 *   `camerasRemoved` attr, so the removal holds when more of its media joins.
 *
 * A folder that is not an album has the cameras of its media and nothing else.
 */

import { basename, resolve } from '@std/path';
import type { Command, ContainerListing, NodeId } from '@ein/client';
import { shq } from '@ein/client';
import { NODE_TYPE_CAMERA } from '@archive/camera/camera';
import type { AlbumCamera, AlbumCameraList } from '@archive/media/api';
import { NODE_TYPE_ALBUM } from '@archive/media/types';

/** The album's directory of the cameras added to it by hand. */
const ALBUM_CAMERAS_DIR = 'cameras';

/** Album attr: the paths of the cameras that took some of its media and were removed from its list. */
const CAMERAS_REMOVED_ATTR = 'camerasRemoved';

/** Ids per batched lookup. */
const IDS_PER_CALL = 1000;

type Node = Awaited<ReturnType<Command['sys']['vfs']['get']>>;

const removedOf = (album: Node): string[] => {
  const value = album.attrs[CAMERAS_REMOVED_ATTR];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** How many of the media `path` shows each camera took (`members`, a stack's front for the whole stack). */
const mediaDevices = async (cmd: Command, path: string): Promise<Map<string, number>> => {
  const listed = await cmd.execute(`JSON_OUTPUT=1 members ${shq(path)}`);
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || `${path}: cannot list its members`);
  const ids: NodeId[] = (JSON.parse(listed.stdout) as ContainerListing).members.filter((member) => !member.front).map((member) => member.id);
  const counts = new Map<string, number>();
  for (let offset = 0; offset < ids.length; offset += IDS_PER_CALL) {
    for (const node of (await cmd.sys.vfs.getNodesByIds(cmd.access, ids.slice(offset, offset + IDS_PER_CALL))).values()) {
      const camera = node.attrs.cameraPath;
      if (typeof camera === 'string') counts.set(camera, (counts.get(camera) ?? 0) + 1);
    }
  }
  return counts;
};

/** The cameras linked from the album's `cameras/`, by the link's name. None when it has no such directory. */
const addedCameras = async (cmd: Command, albumPath: string): Promise<Map<string, string>> => {
  const dir = `${albumPath}/${ALBUM_CAMERAS_DIR}`;
  const added = new Map<string, string>();
  if (!(await cmd.sys.vfs.exists(cmd.access, dir, { follow: false }))) return added;
  for (const entry of await cmd.sys.vfs.children(cmd.access, dir)) {
    if (entry.node.props.softlink) added.set(resolve(dir, entry.node.props.softlink), entry.name);
  }
  return added;
};

/** The camera at `path` as a row, or undefined when it is gone, unreadable or not a camera. */
const cameraRow = async (cmd: Command, path: string, source: AlbumCamera['source'], media: number): Promise<AlbumCamera | undefined> => {
  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);
    if (node.type !== NODE_TYPE_CAMERA) return undefined;
    const name = typeof node.attrs.name === 'string' && node.attrs.name.trim() ? node.attrs.name : basename(path);
    return { path, name, source, media };
  } catch {
    return undefined;
  }
};

const byMedia = (a: AlbumCamera, b: AlbumCamera): number => b.media - a.media || a.name.localeCompare(b.name);

/** The cameras of the album or folder at `path` (see the file comment). */
export const albumCameras = async (cmd: Command, path: string): Promise<AlbumCameraList> => {
  const container = await cmd.sys.vfs.get(cmd.access, path);
  const album = container.type === NODE_TYPE_ALBUM;
  const counts = await mediaDevices(cmd, path);
  const removedPaths = new Set(album ? removedOf(container) : []);
  const added = album ? await addedCameras(cmd, path) : new Map<string, string>();

  const rows = await Promise.all([
    ...[...counts].map(([camera, media]) => cameraRow(cmd, camera, 'media', media)),
    ...[...added.keys()].filter((camera) => !counts.has(camera)).map((camera) => cameraRow(cmd, camera, 'added', 0)),
  ]);
  const cameras: AlbumCamera[] = [];
  const removed: AlbumCamera[] = [];
  for (const row of rows) {
    if (!row) continue;
    // A link lists its camera even when that camera is also named as removed.
    if (removedPaths.has(row.path) && !added.has(row.path)) removed.push(row);
    else cameras.push(row);
  }
  cameras.sort((a, b) => (a.source === b.source ? byMedia(a, b) : a.source === 'media' ? -1 : 1));
  removed.sort(byMedia);
  return { album: path, cameras, removed };
};

/** The album at `path`, or an error saying it is not one. */
const albumNode = async (cmd: Command, path: string): Promise<Node> => {
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== NODE_TYPE_ALBUM) throw new Error(`${path}: not an album (is ${node.type})`);
  return node;
};

/** The camera at `path`, or an error saying it is not one. */
const cameraNode = async (cmd: Command, path: string): Promise<Node> => {
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== NODE_TYPE_CAMERA) throw new Error(`${path}: not a camera (is ${node.type})`);
  return node;
};

const setRemoved = async (cmd: Command, albumPath: string, removed: string[]): Promise<void> => {
  await cmd.sys.vfs.update(cmd.access, albumPath, { attrs: { [CAMERAS_REMOVED_ATTR]: removed.length > 0 ? removed : null } });
};

/**
 * Put `camera` on the album's list: no longer removed, and linked from `cameras/` unless it took
 * some of the album's media, which lists it already. True when the list changed.
 */
export const addAlbumCamera = async (cmd: Command, albumPath: string, camera: string): Promise<boolean> => {
  const album = await albumNode(cmd, albumPath);
  await cameraNode(cmd, camera);
  const removed = removedOf(album);
  const wasRemoved = removed.includes(camera);
  if (wasRemoved) await setRemoved(cmd, albumPath, removed.filter((entry) => entry !== camera));

  if ((await mediaDevices(cmd, albumPath)).has(camera)) return wasRemoved;
  if ((await addedCameras(cmd, albumPath)).has(camera)) return wasRemoved;

  // The directory is shared as the album is, so whoever reads the album reads its list.
  const dir = `${albumPath}/${ALBUM_CAMERAS_DIR}`;
  const { mode, gid, acl } = album.props;
  await cmd.sys.vfs.ensure(cmd.access, 'directory', albumPath, ALBUM_CAMERAS_DIR, { props: { mode, gid, ...(acl?.length ? { acl } : {}) } });
  const taken = new Set((await cmd.sys.vfs.children(cmd.access, dir)).map((entry) => entry.name));
  let name = basename(camera);
  for (let n = 2; taken.has(name); n++) name = `${basename(camera)}-${n}`;
  await cmd.sys.vfs.create(cmd.access, 'softlink', dir, name, {
    props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: camera },
  });
  return true;
};

/**
 * Take `camera` off the album's list: its link in `cameras/` goes (and `cameras/` with the last
 * one), and when it took some of the album's media it is named as removed, which keeps it off as
 * more of its media joins. True when the list changed.
 */
export const removeAlbumCamera = async (cmd: Command, albumPath: string, camera: string): Promise<boolean> => {
  const album = await albumNode(cmd, albumPath);
  const link = (await addedCameras(cmd, albumPath)).get(camera);
  if (link) {
    const dir = `${albumPath}/${ALBUM_CAMERAS_DIR}`;
    await cmd.sys.vfs.unlink(cmd.access, `${dir}/${link}`, dir, { readlink: true });
    // The last camera added by hand takes its directory with it.
    if ((await cmd.sys.vfs.childCount(cmd.access, dir, { all: true })) === 0) await cmd.sys.vfs.unlink(cmd.access, dir, albumPath);
  }

  const removed = removedOf(album);
  if (removed.includes(camera) || !(await mediaDevices(cmd, albumPath)).has(camera)) return link !== undefined;
  await setRemoved(cmd, albumPath, [...removed, camera]);
  return true;
};
