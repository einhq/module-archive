/**
 * An album's devices: the ones whose tracks its map draws.
 *
 * - The devices that took its media are on the list, read from the members' `devicePath` each time
 *   it is asked, so media from a new device joining, or a member linked to its device later, is
 *   on it at once — and so is a track that device records later.
 * - A device added by hand is a softlink in the album's `devices/` directory, named by the
 *   device's slug: `<album>/devices/<slug>` → `/archive/devices/<slug>`.
 * - A device that took some of its media and was removed from the list is named in the album's
 *   `devicesRemoved` attr, so the removal holds when more of its media joins.
 *
 * A folder that is not an album has the devices of its media and nothing else.
 */

import { basename, resolve } from '@std/path';
import type { Command, ContainerListing, NodeId } from '@ein/client';
import { shq } from '@ein/client';
import { NODE_TYPE_DEVICE } from '@archive/device/device';
import type { AlbumDevice, AlbumDeviceList } from '@archive/media/api';
import { NODE_TYPE_ALBUM } from '@archive/media/types';

/** The album's directory of the devices added to it by hand. */
const ALBUM_DEVICES_DIR = 'devices';

/** Album attr: the paths of the devices that took some of its media and were removed from its list. */
const DEVICES_REMOVED_ATTR = 'devicesRemoved';

/** Ids per batched lookup. */
const IDS_PER_CALL = 1000;

type Node = Awaited<ReturnType<Command['sys']['vfs']['get']>>;

const removedOf = (album: Node): string[] => {
  const value = album.attrs[DEVICES_REMOVED_ATTR];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** How many of the media `path` shows each device took (`members`, a stack's front for the whole stack). */
const mediaDevices = async (cmd: Command, path: string): Promise<Map<string, number>> => {
  const listed = await cmd.execute(`JSON_OUTPUT=1 members ${shq(path)}`);
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || `${path}: cannot list its members`);
  const ids: NodeId[] = (JSON.parse(listed.stdout) as ContainerListing).members.filter((member) => !member.front).map((member) => member.id);
  const counts = new Map<string, number>();
  for (let offset = 0; offset < ids.length; offset += IDS_PER_CALL) {
    for (const node of (await cmd.sys.vfs.getNodesByIds(cmd.access, ids.slice(offset, offset + IDS_PER_CALL))).values()) {
      const device = node.attrs.devicePath;
      if (typeof device === 'string') counts.set(device, (counts.get(device) ?? 0) + 1);
    }
  }
  return counts;
};

/** The devices linked from the album's `devices/`, by the link's name. None when it has no such directory. */
const addedDevices = async (cmd: Command, albumPath: string): Promise<Map<string, string>> => {
  const dir = `${albumPath}/${ALBUM_DEVICES_DIR}`;
  const added = new Map<string, string>();
  if (!(await cmd.sys.vfs.exists(cmd.access, dir, { follow: false }))) return added;
  for (const entry of await cmd.sys.vfs.children(cmd.access, dir)) {
    if (entry.node.props.softlink) added.set(resolve(dir, entry.node.props.softlink), entry.name);
  }
  return added;
};

/** The device at `path` as a row, or undefined when it is gone, unreadable or not a device. */
const deviceRow = async (cmd: Command, path: string, source: AlbumDevice['source'], media: number): Promise<AlbumDevice | undefined> => {
  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);
    if (node.type !== NODE_TYPE_DEVICE) return undefined;
    const name = typeof node.attrs.name === 'string' && node.attrs.name.trim() ? node.attrs.name : basename(path);
    return { path, name, source, media };
  } catch {
    return undefined;
  }
};

const byMedia = (a: AlbumDevice, b: AlbumDevice): number => b.media - a.media || a.name.localeCompare(b.name);

/** The devices of the album or folder at `path` (see the file comment). */
export const albumDevices = async (cmd: Command, path: string): Promise<AlbumDeviceList> => {
  const container = await cmd.sys.vfs.get(cmd.access, path);
  const album = container.type === NODE_TYPE_ALBUM;
  const counts = await mediaDevices(cmd, path);
  const removedPaths = new Set(album ? removedOf(container) : []);
  const added = album ? await addedDevices(cmd, path) : new Map<string, string>();

  const rows = await Promise.all([
    ...[...counts].map(([device, media]) => deviceRow(cmd, device, 'media', media)),
    ...[...added.keys()].filter((device) => !counts.has(device)).map((device) => deviceRow(cmd, device, 'added', 0)),
  ]);
  const devices: AlbumDevice[] = [];
  const removed: AlbumDevice[] = [];
  for (const row of rows) {
    if (!row) continue;
    // A link lists its device even when that device is also named as removed.
    if (removedPaths.has(row.path) && !added.has(row.path)) removed.push(row);
    else devices.push(row);
  }
  devices.sort((a, b) => (a.source === b.source ? byMedia(a, b) : a.source === 'media' ? -1 : 1));
  removed.sort(byMedia);
  return { album: path, devices, removed };
};

/** The album at `path`, or an error saying it is not one. */
const albumNode = async (cmd: Command, path: string): Promise<Node> => {
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== NODE_TYPE_ALBUM) throw new Error(`${path}: not an album (is ${node.type})`);
  return node;
};

/** The device at `path`, or an error saying it is not one. */
const deviceNode = async (cmd: Command, path: string): Promise<Node> => {
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== NODE_TYPE_DEVICE) throw new Error(`${path}: not a device (is ${node.type})`);
  return node;
};

const setRemoved = async (cmd: Command, albumPath: string, removed: string[]): Promise<void> => {
  await cmd.sys.vfs.update(cmd.access, albumPath, { attrs: { [DEVICES_REMOVED_ATTR]: removed.length > 0 ? removed : null } });
};

/**
 * Put `device` on the album's list: no longer removed, and linked from `devices/` unless it took
 * some of the album's media, which lists it already. True when the list changed.
 */
export const addAlbumDevice = async (cmd: Command, albumPath: string, device: string): Promise<boolean> => {
  const album = await albumNode(cmd, albumPath);
  await deviceNode(cmd, device);
  const removed = removedOf(album);
  const wasRemoved = removed.includes(device);
  if (wasRemoved) await setRemoved(cmd, albumPath, removed.filter((entry) => entry !== device));

  if ((await mediaDevices(cmd, albumPath)).has(device)) return wasRemoved;
  if ((await addedDevices(cmd, albumPath)).has(device)) return wasRemoved;

  // The directory is shared as the album is, so whoever reads the album reads its list.
  const dir = `${albumPath}/${ALBUM_DEVICES_DIR}`;
  const { mode, gid, acl } = album.props;
  await cmd.sys.vfs.ensure(cmd.access, 'directory', albumPath, ALBUM_DEVICES_DIR, { props: { mode, gid, ...(acl?.length ? { acl } : {}) } });
  const taken = new Set((await cmd.sys.vfs.children(cmd.access, dir)).map((entry) => entry.name));
  let name = basename(device);
  for (let n = 2; taken.has(name); n++) name = `${basename(device)}-${n}`;
  await cmd.sys.vfs.create(cmd.access, 'softlink', dir, name, {
    props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: device },
  });
  return true;
};

/**
 * Take `device` off the album's list: its link in `devices/` goes (and `devices/` with the last
 * one), and when it took some of the album's media it is named as removed, which keeps it off as
 * more of its media joins. True when the list changed.
 */
export const removeAlbumDevice = async (cmd: Command, albumPath: string, device: string): Promise<boolean> => {
  const album = await albumNode(cmd, albumPath);
  const link = (await addedDevices(cmd, albumPath)).get(device);
  if (link) {
    const dir = `${albumPath}/${ALBUM_DEVICES_DIR}`;
    await cmd.sys.vfs.unlink(cmd.access, `${dir}/${link}`, dir, { readlink: true });
    // The last device added by hand takes its directory with it.
    if ((await cmd.sys.vfs.childCount(cmd.access, dir, { all: true })) === 0) await cmd.sys.vfs.unlink(cmd.access, dir, albumPath);
  }

  const removed = removedOf(album);
  if (removed.includes(device) || !(await mediaDevices(cmd, albumPath)).has(device)) return link !== undefined;
  await setRemoved(cmd, albumPath, [...removed, device]);
  return true;
};
